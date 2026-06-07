import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolHandlers, getDefaultLookupDbPath } from '../src/index.ts';

test('decode_kifuは局面列を返す', () => {
  const tools = createToolHandlers(getDefaultLookupDbPath());
  const result = tools.decodeKifu({ input: '?m=2433' });

  assert.equal(result.moves.length, 1);
  assert.equal(result.positions.length, 2);
  assert.equal(result.positions[1].move, '３三角');
});

test('evaluate_positionは指定手数のDB真値を返す', () => {
  const tools = createToolHandlers(getDefaultLookupDbPath());
  const result = tools.evaluatePosition({ kifu: '?m=2433', ply: 0 });

  assert.deepEqual(result.evaluation, { result: 'win', ply: 29 });
  assert.equal(result.truthSource, 'lookup.db');
});

test('analyze_movesは合法手と分類を返す', () => {
  const tools = createToolHandlers(getDefaultLookupDbPath());
  const result = tools.analyzeMoves({ kifu: '', ply: 0 });

  assert.equal(result.currentEvaluation.result, 'win');
  assert.equal(result.moves.length > 0, true);
  assert.equal(result.bestMoves.every((move) => move.classification === 'best'), true);
  assert.equal(result.perspective, '評価は指し手側視点です');
});

test('get_best_lineは最善応手列を返す', () => {
  const tools = createToolHandlers(getDefaultLookupDbPath());
  const result = tools.getBestLine({ kifu: '', maxPlies: 2 });

  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].bestMoves.length > 0, true);
});

test('describe_positionはDB非依存の注記を含む', () => {
  const tools = createToolHandlers(getDefaultLookupDbPath());
  const result = tools.describePosition({ kifu: '' });

  assert.equal(result.note, '幾何情報のみです。手の良し悪しはlookup.dbの評価で確認してください。');
  assert.equal(result.description.legalMoveCount > 0, true);
});
