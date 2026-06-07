export const SENTE = 'sente';
export const GOTE = 'gote';

export type Player = typeof SENTE | typeof GOTE;
export type PieceType = 'OU' | 'KIN' | 'KAKU' | 'UMA';

export type Piece = {
  type: PieceType;
  owner: Player;
  promoted: boolean;
};

export type Board = Array<Array<Piece | null>>;

export type GameState = {
  board: Board;
  hands: Record<Player, PieceType[]>;
  turn: Player;
};

export type BoardMoveRecord = {
  type: 'board';
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  piece?: PieceType;
  promote: boolean;
};

export type HandMoveRecord = {
  type: 'hand';
  toX: number;
  toY: number;
  piece: PieceType;
  promote: false;
};

export type MoveRecord = BoardMoveRecord | HandMoveRecord;

export type GeneratedMove = {
  state: GameState;
  record: MoveRecord;
  japanese: string;
};

export type EvaluationResult = 'win' | 'lose' | 'draw' | 'unknown';

export type Evaluation = {
  result: EvaluationResult;
  ply?: number;
};

export type MoveClassification = 'best' | 'inaccuracy' | 'blunder' | 'mistake' | 'unknown';

export type ClassifiedMove<T extends string = string> = {
  id: T;
  evaluationForMover: Evaluation;
  classification: MoveClassification;
  plyDelta: number | null;
  isBest: boolean;
};

export type PositionSnapshot = {
  ply: number;
  turn: Player;
  hash: string;
  sfenLike: string;
  state: GameState;
};
