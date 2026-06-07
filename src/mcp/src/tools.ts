import { analyzeMoves, getBestLine } from './analysis.js';
import { describePosition, HashCalc, stateToSfenLike } from './shogi.js';
import { KifuCodec, replayKifu } from './kifu.js';
import { getDefaultLookupDbPath, openLookupDatabase } from './lookup.js';
import { GameState, PositionSnapshot } from './types.js';

type PositionInput = {
  input?: string;
  kifu?: string;
  ply?: number;
  state?: GameState;
};

type DecodeKifuInput = {
  input: string;
  moveLimit?: number;
};

type BestLineInput = PositionInput & {
  maxPlies?: number;
};

export function createToolHandlers(dbPath = getDefaultLookupDbPath()) {
  let db: ReturnType<typeof openLookupDatabase> | null = null;
  const getDb = () => {
    db ??= openLookupDatabase(dbPath);
    return db;
  };

  return {
    decodeKifu(input: DecodeKifuInput) {
      const decoded = replayKifu(input.input, { moveLimit: input.moveLimit });
      return {
        input: decoded.input,
        moves: decoded.moves,
        positions: decoded.positions.map((position, index) => serializePosition(position, decoded.moves[index - 1]?.japanese ?? null)),
      };
    },

    evaluatePosition(input: PositionInput) {
      const position = resolvePosition(input);
      return {
        truthSource: 'lookup.db',
        hash: position.hash,
        turn: position.turn,
        sfenLike: position.sfenLike,
        evaluation: getDb().evaluateState(position.state),
      };
    },

    analyzeMoves(input: PositionInput) {
      const position = resolvePosition(input);
      const analyzed = analyzeMoves(position.state, getDb());
      return {
        truthSource: 'lookup.db',
        perspective: '評価は指し手側視点です',
        classificationBasis: '結果が変わったか、および勝ちは最短ply・負けは最長plyかで分類します。',
        ...analyzed,
      };
    },

    getBestLine(input: BestLineInput) {
      const position = resolvePosition(input);
      const maxPlies = Math.max(1, Math.min(input.maxPlies ?? 8, 64));
      return {
        truthSource: 'lookup.db',
        perspective: '各手の評価はその手を指した側の視点です',
        ...getBestLine(position.state, getDb(), maxPlies),
      };
    },

    describePosition(input: PositionInput) {
      const position = resolvePosition(input);
      return {
        hash: position.hash,
        turn: position.turn,
        sfenLike: position.sfenLike,
        note: '幾何情報のみです。手の良し悪しはlookup.dbの評価で確認してください。',
        description: describePosition(position.state),
      };
    },

    close() {
      db?.close();
      db = null;
    },
  };
}

function resolvePosition(input: PositionInput): PositionSnapshot {
  if (input.state) {
    return {
      ply: input.ply ?? 0,
      turn: input.state.turn,
      hash: HashCalc.hashToString(HashCalc.calcHash(input.state)),
      sfenLike: stateToSfenLike(input.state),
      state: input.state,
    };
  }

  const kifu = input.kifu ?? input.input ?? '';
  const decoded = replayKifu(kifu);
  const ply = input.ply ?? decoded.positions.length - 1;
  const position = decoded.positions[ply];
  if (!position) throw new Error(`指定手数の局面がありません: ${ply}`);
  return position;
}

function serializePosition(position: PositionSnapshot, move: string | null) {
  return {
    ply: position.ply,
    move,
    turn: position.turn,
    hash: position.hash,
    sfenLike: position.sfenLike,
    board: position.state.board,
    hands: position.state.hands,
  };
}

export { KifuCodec };
