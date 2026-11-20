// Logic cờ caro dùng chung cho server (Node) và trình duyệt.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CaroLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SIZE = 15;           // Bàn cờ 15x15
  const WIN = 5;             // 5 quân liên tiếp
  const EDGE_BLOCKS = false; // true = mép bàn cờ cũng tính là "bị chặn"
  const TURN_MS = 30000;     // 30 giây mỗi lượt

  const other = (s) => (s === 'X' ? 'O' : 'X');
  const inside = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  const createBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(null));

  // Trả về mảng ô thắng, hoặc null.
  // Luật chặn 2 đầu: dãy >= 5 quân nhưng cả 2 đầu đều bị quân đối thủ chặn thì KHÔNG thắng.
  function checkWin(board, r, c) {
    const p = board[r][c];
    if (!p) return null;
    const opp = other(p);
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      const line = [[r, c]];
      let i = r + dr, j = c + dc;
      while (inside(i, j) && board[i][j] === p) { line.push([i, j]); i += dr; j += dc; }
      const blockedA = inside(i, j) ? board[i][j] === opp : EDGE_BLOCKS;
      i = r - dr; j = c - dc;
      while (inside(i, j) && board[i][j] === p) { line.unshift([i, j]); i -= dr; j -= dc; }
      const blockedB = inside(i, j) ? board[i][j] === opp : EDGE_BLOCKS;
      if (line.length >= WIN && !(blockedA && blockedB)) return line;
    }
    return null;
  }

  // Nước đi ngẫu nhiên khi hết giờ: chọn ngẫu nhiên 1 ô trống sát các quân đã có
  // (để nước đi không rơi quá xa bàn cờ). Bàn trống thì đánh ô giữa.
  function randomMove(board) {
    const near = [], empty = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (board[r][c]) continue;
      empty.push([r, c]);
      let adj = false;
      for (let dr = -1; dr <= 1 && !adj; dr++) for (let dc = -1; dc <= 1; dc++) {
        if ((dr || dc) && inside(r + dr, c + dc) && board[r + dr][c + dc]) { adj = true; break; }
      }
      if (adj) near.push([r, c]);
    }
    const pool = near.length ? near : empty;
    if (!pool.length) return null;
    if (!near.length && !board[7][7]) return [7, 7];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  class Game {
    constructor() {
      this.scores = { X: 0, O: 0, draw: 0 };
      this.gameNo = 0;
      this.first = 'O'; // newGame() sẽ đảo → ván 1 X đi trước
      this.newGame();
    }
    // Mỗi ván mới đổi luân phiên người đi trước
    newGame() {
      this.gameNo++;
      this.first = other(this.first);
      this.board = createBoard();
      this.turn = this.first;
      this.status = 'playing';
      this.winner = null;
      this.winLine = null;
      this.lastMove = null;
      this.moveCount = 0;
      this.endReason = null;
      this.lastAuto = false;
    }
    play(sym, r, c, auto = false) {
      if (this.status !== 'playing') return 'Ván đã kết thúc';
      if (sym !== this.turn) return 'Chưa đến lượt bạn';
      if (!Number.isInteger(r) || !Number.isInteger(c) || !inside(r, c)) return 'Nước đi không hợp lệ';
      if (this.board[r][c]) return 'Ô này đã có quân';
      this.board[r][c] = sym;
      this.lastMove = [r, c];
      this.lastAuto = !!auto;
      this.moveCount++;
      const line = checkWin(this.board, r, c);
      if (line) {
        this.status = 'over'; this.winner = sym; this.winLine = line;
        this.scores[sym]++; this.endReason = 'five';
      } else if (this.moveCount === SIZE * SIZE) {
        this.status = 'over'; this.scores.draw++; this.endReason = 'full';
      } else {
        this.turn = other(sym);
      }
      return null;
    }
    resign(sym) {
      if (this.status !== 'playing') return 'Ván đã kết thúc';
      this.status = 'over'; this.winner = other(sym);
      this.scores[this.winner]++; this.endReason = 'resign';
      return null;
    }
    // Hết giờ: đánh hộ người đang tới lượt 1 nước ngẫu nhiên
    autoPlay() {
      if (this.status !== 'playing') return null;
      const mv = randomMove(this.board);
      if (!mv) return null;
      this.play(this.turn, mv[0], mv[1], true);
      return mv;
    }
    toJSON() {
      const { board, turn, first, status, winner, winLine, lastMove, lastAuto, moveCount, scores, gameNo, endReason } = this;
      return { board, turn, first, status, winner, winLine, lastMove, lastAuto, moveCount, scores, gameNo, endReason };
    }
  }

  return { SIZE, WIN, EDGE_BLOCKS, TURN_MS, other, inside, createBoard, checkWin, randomMove, Game };
});
