// Server cờ caro: phục vụ giao diện + WebSocket để chơi online / mạng LAN.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, TURN_MS: DEFAULT_TURN_MS } = require('./game-logic.js');
const TURN_MS = Number(process.env.TURN_MS) || DEFAULT_TURN_MS;

const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---------- HTTP tĩnh (chỉ phục vụ 2 file giao diện) ----------
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/game-logic.js': 'game-logic.js' };
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const name = FILES[p];
  if (!name) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, name), (err, data) => {
    if (err) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] });
    res.end(data);
  });
});

// ---------- Phòng chơi ----------
const rooms = new Map(); // code -> room
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join(''); } while (rooms.has(code));
  return code;
}
const cleanName = (n, fb) => (String(n || '').trim().slice(0, 20) || fb);
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

// ---------- Đồng hồ 30s mỗi lượt (server quyết định) ----------
// Đồng hồ chỉ chạy khi ván đang diễn ra và CẢ 2 người chơi đều đang kết nối.
// Hết giờ → server đánh hộ 1 nước ngẫu nhiên cho người đang tới lượt.
function syncTimer(room) {
  const g = room.game;
  const online = ['X', 'O'].every((s) => room.players[s] && room.players[s].ws);
  const run = g.status === 'playing' && online;
  const key = run ? `${g.gameNo}:${g.moveCount}` : null;
  if (key === room.timerKey) return;
  clearTimeout(room.timer);
  room.timerKey = key;
  room.deadline = null;
  if (!run) return;
  room.deadline = Date.now() + TURN_MS;
  room.timer = setTimeout(() => {
    if (room.timerKey !== key || !rooms.has(room.code)) return;
    const sym = g.turn;
    const name = room.players[sym] ? room.players[sym].name : sym;
    if (g.autoPlay()) broadcast(room, { t: 'info', msg: `Hết giờ! Đã đánh ngẫu nhiên thay ${name}` });
  }, TURN_MS + 150);
}

function roomState(room) {
  const pl = (s) => room.players[s] ? { name: room.players[s].name, online: !!room.players[s].ws } : null;
  return {
    t: 'state', room: room.code,
    players: { X: pl('X'), O: pl('O') },
    spectators: room.spectators.size,
    ready: !!(room.players.X && room.players.O),
    turnMs: TURN_MS,
    timeLeft: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    ...room.game.toJSON(),
  };
}
function sendAll(room, msg) {
  for (const s of ['X', 'O']) if (room.players[s]) send(room.players[s].ws, msg);
  for (const ws of room.spectators) send(ws, msg);
}
function broadcast(room, extra) {
  syncTimer(room);
  const st = roomState(room);
  for (const s of ['X', 'O']) if (room.players[s]) send(room.players[s].ws, st);
  for (const ws of room.spectators) send(ws, st);
  if (extra) {
    for (const s of ['X', 'O']) if (room.players[s]) send(room.players[s].ws, extra);
    for (const ws of room.spectators) send(ws, extra);
  }
}

function detach(ws, explicit) {
  const info = ws.info; if (!info) return;
  ws.info = null;
  const room = rooms.get(info.room); if (!room) return;
  if (info.sym === 'spec') room.spectators.delete(ws);
  else if (room.players[info.sym] && room.players[info.sym].ws === ws) {
    const name = room.players[info.sym].name;
    if (explicit) room.players[info.sym] = null;        // rời phòng → nhường chỗ
    else room.players[info.sym].ws = null;               // mất kết nối → giữ chỗ để vào lại
    broadcast(room, { t: 'info', msg: `${name} ${explicit ? 'đã rời phòng' : 'đã mất kết nối'}` });
  }
  room.lastActive = Date.now();
}

function attach(ws, room, sym, name, token) {
  ws.info = { room: room.code, sym, name };
  if (sym === 'spec') room.spectators.add(ws);
  else {
    const old = room.players[sym] && room.players[sym].ws;
    if (old && old !== ws) { old.info = null; send(old, { t: 'kicked' }); old.close(); }
    room.players[sym] = { name, token, ws };
  }
  send(ws, { t: 'joined', room: room.code, you: sym, token });
  send(ws, { t: 'chatHistory', list: room.chat });
  broadcast(room, sym === 'spec' ? null : { t: 'info', msg: `${name} đã vào phòng (${sym})` });
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('close', () => detach(ws, false));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const err = (msg) => send(ws, { t: 'error', msg });

    if (m.t === 'create') {
      detach(ws, true);
      const room = { code: newCode(), players: { X: null, O: null }, spectators: new Set(), game: new Game(), chat: [], lastActive: Date.now() };
      rooms.set(room.code, room);
      return attach(ws, room, 'X', cleanName(m.name, 'Người chơi 1'), crypto.randomUUID());
    }

    if (m.t === 'join') {
      const room = rooms.get(String(m.room || '').toUpperCase().trim());
      if (!room) return err('Không tìm thấy phòng này');
      detach(ws, true);
      for (const s of ['X', 'O']) {
        const p = room.players[s];
        if (p && m.token && p.token === m.token) return attach(ws, room, s, cleanName(m.name, p.name), p.token);
      }
      for (const s of ['X', 'O']) {
        if (!room.players[s]) return attach(ws, room, s, cleanName(m.name, s === 'X' ? 'Người chơi 1' : 'Người chơi 2'), crypto.randomUUID());
      }
      return attach(ws, room, 'spec', cleanName(m.name, 'Khán giả'), null);
    }

    const info = ws.info; if (!info) return err('Bạn chưa vào phòng');
    const room = rooms.get(info.room); if (!room) return err('Phòng không còn tồn tại');
    room.lastActive = Date.now();
    if (m.t === 'leave') return detach(ws, true);
    if (m.t === 'chat') {
      const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) return;
      const now = Date.now();
      if (ws.lastChat && now - ws.lastChat < 400) return err('Bạn gửi tin nhắn hơi nhanh');
      ws.lastChat = now;
      const name = info.sym === 'spec' ? info.name : (room.players[info.sym] ? room.players[info.sym].name : info.name);
      const msg = { sym: info.sym, name, text, ts: now };
      room.chat.push(msg); if (room.chat.length > 50) room.chat.shift();
      return sendAll(room, { t: 'chat', msg });
    }
    if (info.sym === 'spec') return err('Bạn đang xem, không thể thao tác');
    const ready = room.players.X && room.players.O;

    if (m.t === 'move') {
      if (!ready) return err('Đang chờ đối thủ vào phòng');
      const e = room.game.play(info.sym, m.r, m.c);
      return e ? err(e) : broadcast(room);
    }
    if (m.t === 'resign') {
      if (!ready) return err('Chưa có đối thủ');
      const e = room.game.resign(info.sym);
      return e ? err(e) : broadcast(room, { t: 'info', msg: `${room.players[info.sym].name} đã đầu hàng` });
    }
    if (m.t === 'newGame') {
      if (room.game.status !== 'over') return err('Ván hiện tại chưa kết thúc');
      room.game.newGame();
      return broadcast(room, { t: 'info', msg: `Ván ${room.game.gameNo}: ${room.game.first} đi trước` });
    }
  });
});

// Ping giữ kết nối + dọn phòng bỏ trống quá 30 phút
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = ['X', 'O'].some((s) => room.players[s] && room.players[s].ws) || room.spectators.size;
    if (!anyone && now - room.lastActive > 30 * 60 * 1000) { clearTimeout(room.timer); rooms.delete(code); }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`\n  Cờ Caro đang chạy!`);
  console.log(`  - Máy này:      http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  - Mạng LAN:     http://${a.address}:${PORT}`);
  }
  console.log('');
});
