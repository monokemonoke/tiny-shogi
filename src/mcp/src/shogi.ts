import {
  Board,
  GOTE,
  GameState,
  GeneratedMove,
  MoveRecord,
  Piece,
  PieceType,
  Player,
  SENTE,
} from './types.js';

const CONFIG = { rows: 4, cols: 4 };

const PIECE_DEFS: Record<PieceType, { name: string; moves: number[][]; range?: boolean; slidingPart?: number[][] }> = {
  OU: { name: '王', moves: [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]] },
  KIN: { name: '金', moves: [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1]] },
  KAKU: { name: '角', moves: [[1, 1], [1, -1], [-1, 1], [-1, -1]], range: true },
  UMA: {
    name: '馬',
    moves: [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0]],
    range: true,
    slidingPart: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  },
};

const PIECE_NAMES: Record<PieceType, string> = {
  OU: '玉',
  KIN: '金',
  KAKU: '角',
  UMA: '馬',
};

export function opponent(player: Player): Player {
  return player === SENTE ? GOTE : SENTE;
}

export function createEmptyBoard(): Board {
  return Array.from({ length: CONFIG.rows }, () => Array<Piece | null>(CONFIG.cols).fill(null));
}

export function createInitialState(): GameState {
  const board = createEmptyBoard();
  board[0][1] = { type: 'KAKU', owner: GOTE, promoted: false };
  board[0][2] = { type: 'KIN', owner: GOTE, promoted: false };
  board[0][3] = { type: 'OU', owner: GOTE, promoted: false };
  board[3][0] = { type: 'OU', owner: SENTE, promoted: false };
  board[3][1] = { type: 'KIN', owner: SENTE, promoted: false };
  board[3][2] = { type: 'KAKU', owner: SENTE, promoted: false };
  return { board, hands: { [SENTE]: [], [GOTE]: [] }, turn: SENTE };
}

export function cloneState(state: GameState): GameState {
  return {
    board: state.board.map((row) => row.map((piece) => (piece ? { ...piece } : null))),
    hands: {
      [SENTE]: [...state.hands[SENTE]],
      [GOTE]: [...state.hands[GOTE]],
    },
    turn: state.turn,
  };
}

export function coordToKifu(x: number, y: number): string {
  return `${4 - x}${y + 1}`;
}

export function kifuToCoord(value: string): { x: number; y: number } {
  const file = Number.parseInt(value[0] ?? '', 10);
  const rank = Number.parseInt(value[1] ?? '', 10);
  if (!Number.isInteger(file) || !Number.isInteger(rank) || file < 1 || file > 4 || rank < 1 || rank > 4) {
    throw new Error(`不正な座標です: ${value}`);
  }
  return { x: 4 - file, y: rank - 1 };
}

export function coordToJapanese(x: number, y: number): string {
  const files = ['１', '２', '３', '４'];
  const ranks = ['一', '二', '三', '四'];
  return `${files[4 - x - 1]}${ranks[y]}`;
}

function movementType(piece: Piece): PieceType {
  if (piece.type === 'UMA' || (piece.type === 'KAKU' && piece.promoted)) return 'UMA';
  return piece.type;
}

function handPieceType(piece: Piece): PieceType {
  return movementType(piece) === 'UMA' ? 'KAKU' : piece.type;
}

export const HashCalc = {
  calcHash(state: GameState): bigint {
    const hash1 = this.encodeHash(state);
    const hash2 = this.encodeHashFlipped(state);
    return hash1 < hash2 ? hash1 : hash2;
  },

  encodeHash(state: GameState): bigint {
    let hash = 0n;
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const piece = state.board[y][x];
        let value = 0;
        if (piece) {
          if (piece.type === 'OU') value = 1;
          else if (piece.type === 'KIN') value = 2;
          else if (piece.type === 'KAKU') value = 3;
          if (movementType(piece) === 'UMA') value = 4;
          if (piece.owner === GOTE) value = -value;
        }
        hash |= BigInt(value & 0xF) << BigInt((y * 4 + x) * 4);
      }
    }

    const senteGold = state.hands[SENTE].filter((piece) => piece === 'KIN').length;
    const senteBishop = state.hands[SENTE].filter((piece) => piece === 'KAKU').length;
    const goteGold = state.hands[GOTE].filter((piece) => piece === 'KIN').length;
    const goteBishop = state.hands[GOTE].filter((piece) => piece === 'KAKU').length;
    hash |= BigInt(senteGold & 0xF) << 64n;
    hash |= BigInt(senteBishop & 0xF) << 68n;
    hash |= BigInt(goteGold & 0xF) << 72n;
    hash |= BigInt(goteBishop & 0xF) << 76n;
    hash |= BigInt(state.turn === SENTE ? 1 : 0) << 80n;
    return hash;
  },

  encodeHashFlipped(state: GameState): bigint {
    let hash = 0n;
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const flippedY = 3 - y;
        const flippedX = 3 - x;
        const piece = state.board[y][x];
        let value = 0;
        if (piece) {
          if (piece.type === 'OU') value = 1;
          else if (piece.type === 'KIN') value = 2;
          else if (piece.type === 'KAKU') value = 3;
          if (movementType(piece) === 'UMA') value = 4;
          if (piece.owner === SENTE) value = -value;
        }
        hash |= BigInt(value & 0xF) << BigInt((flippedY * 4 + flippedX) * 4);
      }
    }

    const senteGold = state.hands[SENTE].filter((piece) => piece === 'KIN').length;
    const senteBishop = state.hands[SENTE].filter((piece) => piece === 'KAKU').length;
    const goteGold = state.hands[GOTE].filter((piece) => piece === 'KIN').length;
    const goteBishop = state.hands[GOTE].filter((piece) => piece === 'KAKU').length;
    hash |= BigInt(goteGold & 0xF) << 64n;
    hash |= BigInt(goteBishop & 0xF) << 68n;
    hash |= BigInt(senteGold & 0xF) << 72n;
    hash |= BigInt(senteBishop & 0xF) << 76n;
    hash |= BigInt(state.turn === GOTE ? 1 : 0) << 80n;
    return hash;
  },

  hashToString(hash: bigint): string {
    return hash.toString(16).toUpperCase().padStart(32, '0');
  },
};

type BoardSelection = { type: 'board'; x: number; y: number; piece: Piece };
type HandSelection = { type: 'hand'; index: number; pKey: PieceType; owner: Player };
type Selection = BoardSelection | HandSelection;

export const ShogiLogic = {
  isPseudoLegalMove(selection: Selection, targetX: number, targetY: number, currentBoard: Board): boolean {
    if (targetX < 0 || targetX >= CONFIG.cols || targetY < 0 || targetY >= CONFIG.rows) return false;

    if (selection.type === 'board') {
      const piece = selection.piece;
      if (currentBoard[targetY][targetX]?.owner === piece.owner) return false;
      const def = PIECE_DEFS[movementType(piece)];
      const dx = targetX - selection.x;
      const dy = targetY - selection.y;

      if (def.range) {
        const signX = Math.sign(dx);
        const signY = Math.sign(dy);
        const isSliding = def.slidingPart
          ? def.slidingPart.some((move) => {
              const moveX = piece.owner === SENTE ? move[0] : -move[0];
              const moveY = piece.owner === SENTE ? move[1] : -move[1];
              if ((moveX === 0 && dx !== 0) || (moveY === 0 && dy !== 0)) return false;
              if ((moveX !== 0 && dx % moveX !== 0) || (moveY !== 0 && dy % moveY !== 0)) return false;
              const stepX = moveX !== 0 ? dx / moveX : 999;
              const stepY = moveY !== 0 ? dy / moveY : 999;
              if (stepX === 999) return stepY > 0;
              if (stepY === 999) return stepX > 0;
              return stepX === stepY && stepX > 0;
            })
          : Math.abs(dx) === Math.abs(dy) && Math.abs(dx) > 0;

        if (isSliding) {
          let x = selection.x + signX;
          let y = selection.y + signY;
          while (x !== targetX || y !== targetY) {
            if (currentBoard[y][x] !== null) return false;
            x += signX;
            y += signY;
          }
          return true;
        }
      }

      return def.moves.some((move) => {
        const moveX = piece.owner === SENTE ? move[0] : -move[0];
        const moveY = piece.owner === SENTE ? move[1] : -move[1];
        return dx === moveX && dy === moveY;
      });
    }

    return currentBoard[targetY][targetX] === null;
  },

  isLegalMove(selection: Selection, targetX: number, targetY: number, owner: Player, currentBoard: Board): boolean {
    if (!this.isPseudoLegalMove(selection, targetX, targetY, currentBoard)) return false;
    const simBoard = currentBoard.map((row) => row.map((piece) => (piece ? { ...piece } : null)));
    if (selection.type === 'board') {
      const piece = simBoard[selection.y][selection.x];
      simBoard[selection.y][selection.x] = null;
      simBoard[targetY][targetX] = piece;
    } else {
      simBoard[targetY][targetX] = { type: selection.pKey, owner, promoted: false };
    }
    return !this.isKingInCheck(simBoard, owner);
  },

  isKingInCheck(board: Board, targetOwner: Player): boolean {
    const king = findKing(board, targetOwner);
    if (!king) return true;
    const attacker = opponent(targetOwner);
    for (let y = 0; y < CONFIG.rows; y += 1) {
      for (let x = 0; x < CONFIG.cols; x += 1) {
        const piece = board[y][x];
        if (!piece || piece.owner !== attacker) continue;
        if (this.isPseudoLegalMove({ type: 'board', x, y, piece }, king.x, king.y, board)) return true;
      }
    }
    return false;
  },
};

export function canPromote(piece: Piece, fromY: number, toY: number): boolean {
  if (piece.type !== 'KAKU' || piece.promoted) return false;
  return (piece.owner === SENTE && (fromY === 0 || toY === 0)) || (piece.owner === GOTE && (fromY === 3 || toY === 3));
}

export function applyMove(state: GameState, selection: Selection, targetX: number, targetY: number, promote: boolean): GameState {
  const nextState = cloneState(state);
  const turn = state.turn;
  nextState.turn = opponent(turn);

  if (selection.type === 'board') {
    const piece = { ...selection.piece };
    if (promote) piece.promoted = true;
    nextState.board[selection.y][selection.x] = null;

    const target = nextState.board[targetY][targetX];
    if (target) {
      nextState.hands[turn].push(handPieceType(target));
    }

    nextState.board[targetY][targetX] = piece;
  } else {
    nextState.board[targetY][targetX] = { type: selection.pKey, owner: turn, promoted: false };
    nextState.hands[turn].splice(selection.index, 1);
  }

  return nextState;
}

export function applyMoveRecord(state: GameState, record: MoveRecord): { state: GameState; record: MoveRecord; japanese: string } {
  const turn = state.turn;
  if (record.type === 'board') {
    const piece = state.board[record.fromY][record.fromX];
    if (!piece || piece.owner !== turn) {
      throw new Error(`棋譜の移動元に手番側の駒がありません: ${coordToKifu(record.fromX, record.fromY)}`);
    }
    if (!ShogiLogic.isLegalMove({ type: 'board', x: record.fromX, y: record.fromY, piece }, record.toX, record.toY, turn, state.board)) {
      throw new Error(`不合法手です: ${coordToKifu(record.fromX, record.fromY)}${coordToKifu(record.toX, record.toY)}`);
    }
    if (record.promote && !canPromote(piece, record.fromY, record.toY)) {
      throw new Error(`成れない手です: ${coordToKifu(record.fromX, record.fromY)}${coordToKifu(record.toX, record.toY)}+`);
    }
    const enriched: MoveRecord = { ...record, piece: movementType(piece) };
    return {
      state: applyMove(state, { type: 'board', x: record.fromX, y: record.fromY, piece }, record.toX, record.toY, record.promote),
      record: enriched,
      japanese: moveToJapanese(enriched),
    };
  }

  const handIndex = state.hands[turn].indexOf(record.piece);
  if (handIndex < 0) throw new Error(`持ち駒に${PIECE_NAMES[record.piece]}がありません`);
  if (!ShogiLogic.isLegalMove({ type: 'hand', index: handIndex, pKey: record.piece, owner: turn }, record.toX, record.toY, turn, state.board)) {
    throw new Error(`不合法な打ち手です: ${PIECE_NAMES[record.piece]}${coordToKifu(record.toX, record.toY)}`);
  }
  return {
    state: applyMove(state, { type: 'hand', index: handIndex, pKey: record.piece, owner: turn }, record.toX, record.toY, false),
    record,
    japanese: moveToJapanese(record),
  };
}

export function generateNextStates(state: GameState): GeneratedMove[] {
  const moves: GeneratedMove[] = [];
  const turn = state.turn;

  for (let y = 0; y < CONFIG.rows; y += 1) {
    for (let x = 0; x < CONFIG.cols; x += 1) {
      const piece = state.board[y][x];
      if (!piece || piece.owner !== turn) continue;

      for (let targetY = 0; targetY < CONFIG.rows; targetY += 1) {
        for (let targetX = 0; targetX < CONFIG.cols; targetX += 1) {
          const selection: BoardSelection = { type: 'board', x, y, piece };
          if (!ShogiLogic.isLegalMove(selection, targetX, targetY, turn, state.board)) continue;

          const baseRecord: MoveRecord = {
            type: 'board',
            fromX: x,
            fromY: y,
            toX: targetX,
            toY: targetY,
            piece: movementType(piece),
            promote: false,
          };
          moves.push({
            state: applyMove(state, selection, targetX, targetY, false),
            record: baseRecord,
            japanese: moveToJapanese(baseRecord),
          });

          if (canPromote(piece, y, targetY)) {
            const promotedRecord: MoveRecord = { ...baseRecord, promote: true };
            moves.push({
              state: applyMove(state, selection, targetX, targetY, true),
              record: promotedRecord,
              japanese: moveToJapanese(promotedRecord),
            });
          }
        }
      }
    }
  }

  for (const pieceType of [...new Set(state.hands[turn])]) {
    for (let y = 0; y < CONFIG.rows; y += 1) {
      for (let x = 0; x < CONFIG.cols; x += 1) {
        const index = state.hands[turn].indexOf(pieceType);
        const selection: HandSelection = { type: 'hand', index, pKey: pieceType, owner: turn };
        if (!ShogiLogic.isLegalMove(selection, x, y, turn, state.board)) continue;
        const record: MoveRecord = { type: 'hand', toX: x, toY: y, piece: pieceType, promote: false };
        moves.push({
          state: applyMove(state, selection, x, y, false),
          record,
          japanese: moveToJapanese(record),
        });
      }
    }
  }

  return moves;
}

export function moveToJapanese(move: MoveRecord, previousMove?: MoveRecord): string {
  const sameSquare = previousMove && previousMove.toX === move.toX && previousMove.toY === move.toY;
  const square = sameSquare ? '同' : coordToJapanese(move.toX, move.toY);
  const pieceName = PIECE_NAMES[move.piece ?? 'OU'];
  if (move.type === 'hand') return `${square}${pieceName}打`;
  return `${square}${pieceName}${move.promote ? '成' : ''}`;
}

export function stateToSfenLike(state: GameState): string {
  const rows = state.board.map((row) => {
    let empty = 0;
    let text = '';
    for (const piece of row) {
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        text += String(empty);
        empty = 0;
      }
      text += pieceToSfen(piece);
    }
    return text + (empty > 0 ? String(empty) : '');
  });
  return `${rows.join('/')} ${state.turn === SENTE ? 'b' : 'w'} ${handsToSfen(state)}`;
}

function pieceToSfen(piece: Piece): string {
  const type = movementType(piece);
  const symbol = type === 'OU' ? 'K' : type === 'KIN' ? 'G' : type === 'KAKU' ? 'B' : '+B';
  return piece.owner === SENTE ? symbol : symbol.toLowerCase();
}

function handsToSfen(state: GameState): string {
  const parts: string[] = [];
  for (const [owner, pieces] of [[SENTE, state.hands[SENTE]], [GOTE, state.hands[GOTE]]] as const) {
    for (const type of ['KAKU', 'KIN'] as const) {
      const count = pieces.filter((piece) => piece === type).length;
      if (count === 0) continue;
      const symbol = type === 'KAKU' ? 'B' : 'G';
      parts.push(`${count > 1 ? count : ''}${owner === SENTE ? symbol : symbol.toLowerCase()}`);
    }
  }
  return parts.length > 0 ? parts.join('') : '-';
}

function findKing(board: Board, owner: Player): { x: number; y: number } | null {
  for (let y = 0; y < CONFIG.rows; y += 1) {
    for (let x = 0; x < CONFIG.cols; x += 1) {
      const piece = board[y][x];
      if (piece?.owner === owner && piece.type === 'OU') return { x, y };
    }
  }
  return null;
}

export function describePosition(state: GameState) {
  const legalMoves = generateNextStates(state);
  const senteKing = findKing(state.board, SENTE);
  const goteKing = findKing(state.board, GOTE);
  const capturablePieces = legalMoves
    .filter((move) => move.record.type === 'board' && state.board[move.record.toY][move.record.toX]?.owner === opponent(state.turn))
    .map((move) => ({
      move: move.japanese,
      square: coordToJapanese(move.record.toX, move.record.toY),
      piece: PIECE_NAMES[state.board[move.record.toY][move.record.toX]?.type ?? 'OU'],
    }));

  return {
    turn: state.turn,
    inCheck: ShogiLogic.isKingInCheck(state.board, state.turn),
    legalMoveCount: legalMoves.length,
    capturablePieces,
    attacks: {
      sente: collectAttacks(state, SENTE),
      gote: collectAttacks(state, GOTE),
    },
    kings: {
      sente: senteKing ? { ...senteKing, square: coordToJapanese(senteKing.x, senteKing.y) } : null,
      gote: goteKing ? { ...goteKing, square: coordToJapanese(goteKing.x, goteKing.y) } : null,
    },
    kingDistance:
      senteKing && goteKing
        ? {
            manhattan: Math.abs(senteKing.x - goteKing.x) + Math.abs(senteKing.y - goteKing.y),
            chebyshev: Math.max(Math.abs(senteKing.x - goteKing.x), Math.abs(senteKing.y - goteKing.y)),
          }
        : null,
  };
}

function collectAttacks(state: GameState, owner: Player) {
  const attacks: Array<{ piece: string; from: string; to: string; target: string | null }> = [];
  for (let y = 0; y < CONFIG.rows; y += 1) {
    for (let x = 0; x < CONFIG.cols; x += 1) {
      const piece = state.board[y][x];
      if (!piece || piece.owner !== owner) continue;
      for (let targetY = 0; targetY < CONFIG.rows; targetY += 1) {
        for (let targetX = 0; targetX < CONFIG.cols; targetX += 1) {
          if (x === targetX && y === targetY) continue;
          const target = state.board[targetY][targetX];
          const board = target?.owner === owner ? boardWithoutTarget(state.board, targetX, targetY) : state.board;
          if (!ShogiLogic.isPseudoLegalMove({ type: 'board', x, y, piece }, targetX, targetY, board)) continue;
          attacks.push({
            piece: PIECE_NAMES[movementType(piece)],
            from: coordToJapanese(x, y),
            to: coordToJapanese(targetX, targetY),
            target: target ? PIECE_NAMES[target.type] : null,
          });
        }
      }
    }
  }
  return attacks;
}

function boardWithoutTarget(board: Board, targetX: number, targetY: number): Board {
  const copied = board.map((row) => [...row]);
  copied[targetY][targetX] = null;
  return copied;
}
