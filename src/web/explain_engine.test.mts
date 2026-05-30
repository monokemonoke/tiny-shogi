import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyMoveRecord,
    decodeKifu,
    explainMoveIfBad,
    hashState,
    initialState,
    moveToJapanese,
    replayKifu,
    type AnalyzeResponse
} from './explain_engine.ts';
import type { GameStateSnapshot, MoveRecord } from './position_diff_analysis.ts';

const SENTE = 'sente';
const GOTE = 'gote';

function emptyBoard() {
    return Array.from({ length: 4 }, () => Array(4).fill(null));
}

function state(board: GameStateSnapshot['board'], turn = SENTE): GameStateSnapshot {
    return {
        board,
        hands: { [SENTE]: [], [GOTE]: [] },
        turn
    };
}

test('URL棋譜を復元して初期局面から再生する', () => {
    const moves = decodeKifu('3433');
    const steps = replayKifu(moves);

    assert.equal(steps.length, 1);
    assert.equal(steps[0].moveNumber, 1);
    assert.equal(steps[0].moveLabel, '３三金');
    assert.equal(steps[0].beforeState.turn, SENTE);
    assert.equal(steps[0].afterState.turn, GOTE);
    assert.equal(steps[0].afterState.board[2][1]?.type, 'KIN');
});

test('指し手表記は直前手と同じ移動先なら同を使う', () => {
    const previousMove: MoveRecord = {
        type: 'board',
        fromX: 1,
        fromY: 3,
        toX: 1,
        toY: 2,
        piece: 'KIN',
        promote: false
    };
    const nextMove: MoveRecord = {
        type: 'board',
        fromX: 1,
        fromY: 0,
        toX: 1,
        toY: 2,
        piece: 'KIN',
        promote: false
    };

    assert.equal(moveToJapanese(nextMove, previousMove), '同金');
});

test('実際の手が最善候補より悪い場合だけ差分解説を返す', () => {
    const beforeBoard = emptyBoard();
    beforeBoard[3][0] = { type: 'OU', owner: SENTE, promoted: false };
    beforeBoard[2][1] = { type: 'KIN', owner: SENTE, promoted: false };
    beforeBoard[0][3] = { type: 'KAKU', owner: GOTE, promoted: false };

    const beforeState = state(beforeBoard);
    const move: MoveRecord = {
        type: 'board',
        fromX: 1,
        fromY: 2,
        toX: 1,
        toY: 1,
        piece: 'KIN',
        promote: false
    };
    const { state: afterState } = applyMoveRecord(beforeState, move);
    const analysis: AnalyzeResponse = {
        current_evaluation: { Win: 3 },
        turn: 'Sente',
        hash: hashState(beforeState),
        next_moves: [
            { hash: hashState(afterState), result: { Win: 1 } },
            { hash: '00000000000000000000000000000000', result: { Lose: 3 } }
        ]
    };

    const explanation = explainMoveIfBad(beforeState, move, afterState, analysis, 7, '２二金');

    assert.equal(explanation?.moveNumber, 7);
    assert.equal(explanation?.moveLabel, '２二金');
    assert.equal(explanation?.features[0]?.kind, 'checkOccurred');
});

test('実際の手が最善候補と同点なら解説しない', () => {
    const beforeState = initialState();
    const move = decodeKifu('3433')[0];
    const { state: afterState } = applyMoveRecord(beforeState, move);
    const analysis: AnalyzeResponse = {
        current_evaluation: { Win: 5 },
        turn: 'Sente',
        hash: hashState(beforeState),
        next_moves: [
            { hash: hashState(afterState), result: { Lose: 3 } },
            { hash: '00000000000000000000000000000000', result: { Lose: 3 } }
        ]
    };

    assert.equal(explainMoveIfBad(beforeState, move, afterState, analysis, 1, '３三金'), null);
});
