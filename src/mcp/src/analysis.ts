import { Evaluation, ClassifiedMove, GeneratedMove, GameState, MoveClassification } from './types.js';
import { generateNextStates, HashCalc } from './shogi.js';
import { LookupDatabase } from './lookup.js';

type MoveInput<T extends string> = {
  id: T;
  evaluationForMover: Evaluation;
};

export function classifyAnalyzedMoves<T extends string>(current: Evaluation, moves: Array<MoveInput<T>>): Array<ClassifiedMove<T>> {
  const bestIds = new Set(selectBestMoveIds(current, moves));
  return moves.map((move) => {
    const classification = classifyMove(current, move.evaluationForMover, bestIds.has(move.id));
    return {
      id: move.id,
      evaluationForMover: move.evaluationForMover,
      classification,
      plyDelta:
        current.result === move.evaluationForMover.result && current.ply !== undefined && move.evaluationForMover.ply !== undefined
          ? move.evaluationForMover.ply - current.ply
          : null,
      isBest: bestIds.has(move.id),
    };
  });
}

function selectBestMoveIds<T extends string>(current: Evaluation, moves: Array<MoveInput<T>>): T[] {
  if (moves.length === 0) return [];

  if (current.result === 'win') {
    const finite = moves.filter((move) => move.evaluationForMover.result === 'win' && move.evaluationForMover.ply !== undefined);
    if (finite.length === 0) return [];
    const minPly = Math.min(...finite.map((move) => move.evaluationForMover.ply ?? Number.POSITIVE_INFINITY));
    return finite.filter((move) => move.evaluationForMover.ply === minPly).map((move) => move.id);
  }

  if (current.result === 'draw') {
    const draws = moves.filter((move) => move.evaluationForMover.result === 'draw');
    if (draws.length > 0) return draws.map((move) => move.id);
    return moves.filter((move) => move.evaluationForMover.result === 'win').map((move) => move.id);
  }

  if (current.result === 'lose') {
    const improvements = moves.filter((move) => resultRank(move.evaluationForMover.result) > resultRank(current.result));
    if (improvements.length > 0) {
      const bestRank = Math.max(...improvements.map((move) => resultRank(move.evaluationForMover.result)));
      return improvements.filter((move) => resultRank(move.evaluationForMover.result) === bestRank).map((move) => move.id);
    }
    const finite = moves.filter((move) => move.evaluationForMover.result === 'lose' && move.evaluationForMover.ply !== undefined);
    if (finite.length === 0) return [];
    const maxPly = Math.max(...finite.map((move) => move.evaluationForMover.ply ?? Number.NEGATIVE_INFINITY));
    return finite.filter((move) => move.evaluationForMover.ply === maxPly).map((move) => move.id);
  }

  return [];
}

function classifyMove(current: Evaluation, evaluationForMover: Evaluation, isBest: boolean): MoveClassification {
  if (evaluationForMover.result === 'unknown' || current.result === 'unknown') return 'unknown';
  if (isBest) return 'best';
  if (current.result === 'win' && evaluationForMover.result === 'win') return 'inaccuracy';
  if (current.result === 'win' && evaluationForMover.result !== 'win') return 'blunder';
  if (current.result === 'draw' && evaluationForMover.result === 'lose') return 'mistake';
  if (current.result === evaluationForMover.result) return 'inaccuracy';
  return resultRank(evaluationForMover.result) < resultRank(current.result) ? 'mistake' : 'best';
}

function resultRank(result: Evaluation['result']): number {
  switch (result) {
    case 'win':
      return 3;
    case 'draw':
      return 2;
    case 'lose':
      return 1;
    default:
      return 0;
  }
}

export function invertEvaluation(evaluation: Evaluation): Evaluation {
  if (evaluation.result === 'win') return { result: 'lose', ply: evaluation.ply };
  if (evaluation.result === 'lose') return { result: 'win', ply: evaluation.ply };
  return { ...evaluation };
}

export function analyzeMoves(state: GameState, db: LookupDatabase) {
  const currentEvaluation = db.evaluateState(state);
  const generated = generateNextStates(state);
  const moveInputs = generated.map((move, index) => ({
    id: String(index),
    evaluationForMover: invertEvaluation(db.evaluateState(move.state)),
  }));
  const classified = classifyAnalyzedMoves(currentEvaluation, moveInputs);
  const moves = generated.map((move, index) => {
    const nextHash = HashCalc.hashToString(HashCalc.calcHash(move.state));
    const classification = classified[index];
    return {
      index,
      move: move.japanese,
      record: move.record,
      hash: nextHash,
      childEvaluation: db.evaluateState(move.state),
      evaluationForMover: classification.evaluationForMover,
      classification: classification.classification,
      classificationLabel: classificationLabel(classification.classification),
      plyDelta: classification.plyDelta,
      isBest: classification.isBest,
    };
  });

  return {
    hash: HashCalc.hashToString(HashCalc.calcHash(state)),
    turn: state.turn,
    currentEvaluation,
    moves,
    bestMoves: moves.filter((move) => move.isBest),
  };
}

export function getBestLine(state: GameState, db: LookupDatabase, maxPlies: number) {
  const steps: Array<{
    ply: number;
    hash: string;
    turn: GameState['turn'];
    bestMoves: ReturnType<typeof analyzeMoves>['bestMoves'];
  }> = [];
  let current = state;

  for (let ply = 0; ply < maxPlies; ply += 1) {
    const analyzed = analyzeMoves(current, db);
    steps.push({ ply, hash: analyzed.hash, turn: analyzed.turn, bestMoves: analyzed.bestMoves });
    if (analyzed.bestMoves.length === 0) return { steps, stoppedReason: 'no_legal_moves' as const };
    const selected = analyzed.bestMoves[0];
    const generated = generateNextStates(current)[selected.index] as GeneratedMove | undefined;
    if (!generated) return { steps, stoppedReason: 'internal_mismatch' as const };
    current = generated.state;
  }

  return { steps, stoppedReason: 'max_plies' as const };
}

export function classificationLabel(classification: MoveClassification): string {
  switch (classification) {
    case 'best':
      return '最善手';
    case 'inaccuracy':
      return '緩手';
    case 'blunder':
      return '敗着';
    case 'mistake':
      return '悪手';
    default:
      return '不明';
  }
}
