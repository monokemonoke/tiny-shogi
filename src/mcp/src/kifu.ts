import { GameState, MoveRecord, PieceType, PositionSnapshot } from './types.js';
import { applyMoveRecord, cloneState, coordToKifu, createInitialState, HashCalc, kifuToCoord, moveToJapanese, stateToSfenLike } from './shogi.js';

export const KifuCodec = {
  coordToStr: coordToKifu,
  strToCoord: kifuToCoord,

  pieceToChar(type: string): string {
    switch (type) {
      case 'OU':
        return 'O';
      case 'KIN':
        return 'G';
      case 'KAKU':
      case 'UMA':
        return 'K';
      default:
        return '?';
    }
  },

  charToPiece(char: string): PieceType {
    switch (char) {
      case 'O':
        return 'OU';
      case 'G':
        return 'KIN';
      case 'K':
        return 'KAKU';
      default:
        throw new Error(`不正な駒文字です: ${char}`);
    }
  },

  encodeMove(move: MoveRecord): string {
    if (move.type === 'board') {
      return `${coordToKifu(move.fromX, move.fromY)}${coordToKifu(move.toX, move.toY)}${move.promote ? '+' : ''}`;
    }
    return `${this.pieceToChar(move.piece)}${coordToKifu(move.toX, move.toY)}`;
  },

  decodeMove(value: string): MoveRecord {
    if (/^[A-Z]/.test(value)) {
      const piece = this.charToPiece(value[0] ?? '');
      const to = kifuToCoord(value.slice(1, 3));
      return { type: 'hand', toX: to.x, toY: to.y, piece, promote: false };
    }
    const from = kifuToCoord(value.slice(0, 2));
    const to = kifuToCoord(value.slice(2, 4));
    return { type: 'board', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, promote: value.includes('+') };
  },

  encode(moves: MoveRecord[]): string {
    return moves.map((move) => this.encodeMove(move)).join('-');
  },

  decode(value: string): MoveRecord[] {
    const kifu = extractKifuString(value);
    if (!kifu) return [];
    return kifu.split('-').filter(Boolean).map((part) => this.decodeMove(part));
  },

  moveToJapanese,
};

export function extractKifuString(input: string): string {
  const value = input.trim();
  if (!value) return '';

  try {
    if (value.includes('://')) {
      return new URL(value).searchParams.get('m') ?? '';
    }
  } catch {
    throw new Error(`棋譜URLを解析できません: ${input}`);
  }

  const query = value.startsWith('?') ? value.slice(1) : value;
  if (query.startsWith('m=')) return new URLSearchParams(query).get('m') ?? '';
  return value;
}

export function replayKifu(input: string, options: { moveLimit?: number } = {}) {
  const records = KifuCodec.decode(input);
  const limit = options.moveLimit ?? records.length;
  let state: GameState = createInitialState();
  const positions: PositionSnapshot[] = [snapshot(0, state)];
  const moves: Array<{ ply: number; record: MoveRecord; japanese: string; hash: string }> = [];

  for (const [index, record] of records.slice(0, limit).entries()) {
    const applied = applyMoveRecord(state, record);
    state = applied.state;
    const position = snapshot(index + 1, state);
    positions.push(position);
    moves.push({ ply: index + 1, record: applied.record, japanese: applied.japanese, hash: position.hash });
  }

  return {
    input: extractKifuString(input),
    moves,
    positions,
    finalPosition: positions[positions.length - 1],
  };
}

function snapshot(ply: number, state: GameState): PositionSnapshot {
  const cloned = cloneState(state);
  return {
    ply,
    turn: cloned.turn,
    hash: HashCalc.hashToString(HashCalc.calcHash(cloned)),
    sfenLike: stateToSfenLike(cloned),
    state: cloned,
  };
}
