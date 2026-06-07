import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HashCalc,
  KifuCodec,
  classifyAnalyzedMoves,
  createInitialState,
  describePosition,
  getDefaultLookupDbPath,
  openLookupDatabase,
  replayKifu,
  stateToSfenLike,
} from '../src/index.ts';

test('初期局面のhashとSFEN風表記を固定する', () => {
  const state = createInitialState();

  assert.equal(HashCalc.hashToString(HashCalc.calcHash(state)), '0000000000000000032100000000FED0');
  assert.equal(stateToSfenLike(state), '1bgk/4/4/KGB1 b -');
});

test('URLまたはm文字列から棋譜を再生する', () => {
  const decoded = replayKifu('https://example.test/game?m=2433');

  assert.equal(decoded.moves.length, 1);
  assert.equal(decoded.moves[0].japanese, '３三角');
  assert.equal(decoded.positions.length, 2);
  assert.equal(decoded.positions[1].turn, 'gote');
  assert.equal(KifuCodec.encode(decoded.moves.map((move) => move.record)), '2433');
  assert.equal(stateToSfenLike(decoded.positions[1].state), '1bgk/4/1B2/KG2 w -');
});

test('分類は着手後評価を指し手側視点に反転して判定する', () => {
  const classified = classifyAnalyzedMoves(
    { result: 'win', ply: 3 },
    [
      { id: 'fast', evaluationForMover: { result: 'win', ply: 2 } },
      { id: 'slow', evaluationForMover: { result: 'win', ply: 4 } },
      { id: 'throw', evaluationForMover: { result: 'lose', ply: 1 } },
    ],
  );

  assert.deepEqual(
    classified.map((move) => [move.id, move.classification, move.plyDelta]),
    [
      ['fast', 'best', -1],
      ['slow', 'inaccuracy', 1],
      ['throw', 'blunder', null],
    ],
  );
});

test('引分から負けに落とす手は悪手に分類する', () => {
  const classified = classifyAnalyzedMoves(
    { result: 'draw' },
    [{ id: 'bad', evaluationForMover: { result: 'lose', ply: 5 } }],
  );

  assert.equal(classified[0].classification, 'mistake');
});

test('幾何説明はDB評価と独立した着眼点を返す', () => {
  const description = describePosition(createInitialState());

  assert.equal(description.inCheck, false);
  assert.deepEqual(description.kings.sente, { x: 0, y: 3, square: '４四' });
  assert.deepEqual(description.kings.gote, { x: 3, y: 0, square: '１一' });
  assert.equal(description.legalMoveCount > 0, true);
  assert.equal(description.attacks.sente.some((attack) => attack.to === '３三'), true);
});

test('lookup.dbから初期局面の真値を読む', () => {
  const db = openLookupDatabase(getDefaultLookupDbPath());
  try {
    const state = createInitialState();
    const evaluation = db.evaluateState(state);

    assert.deepEqual(evaluation, { result: 'win', ply: 29 });
  } finally {
    db.close();
  }
});
