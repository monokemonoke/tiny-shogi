import test from 'node:test';
import assert from 'node:assert/strict';
import {
    analyzeEscapeSquares,
    analyzeHangingPieces,
    analyzeKingDanger,
    analyzeLineOpened,
    analyzePositionDiff,
    type GameStateSnapshot,
    type MoveRecord
} from './position_diff_analysis.ts';

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

test('移動した駒で遮っていた相手の角筋が自玉に通ったことを検出する', () => {
    const beforeBoard = emptyBoard();
    beforeBoard[3][0] = { type: 'OU', owner: SENTE, promoted: false };
    beforeBoard[2][1] = { type: 'KIN', owner: SENTE, promoted: false };
    beforeBoard[0][3] = { type: 'KAKU', owner: GOTE, promoted: false };

    const afterBoard = emptyBoard();
    afterBoard[3][0] = { type: 'OU', owner: SENTE, promoted: false };
    afterBoard[1][1] = { type: 'KIN', owner: SENTE, promoted: false };
    afterBoard[0][3] = { type: 'KAKU', owner: GOTE, promoted: false };

    const move: MoveRecord = {
        type: 'board',
        fromX: 1,
        fromY: 2,
        toX: 1,
        toY: 1,
        piece: 'KIN',
        promote: false
    };

    const features = analyzeLineOpened(state(beforeBoard), move, state(afterBoard, GOTE));

    assert.equal(features[0]?.kind, 'lineOpened');
    assert.equal(features[0]?.severity, 'high');
});

test('自玉の逃げ道が減ったことを検出する', () => {
    const beforeBoard = emptyBoard();
    beforeBoard[3][1] = { type: 'OU', owner: SENTE, promoted: false };

    const afterBoard = emptyBoard();
    afterBoard[3][1] = { type: 'OU', owner: SENTE, promoted: false };
    afterBoard[1][1] = { type: 'KIN', owner: GOTE, promoted: false };

    const features = analyzeEscapeSquares(state(beforeBoard), state(afterBoard, GOTE));

    assert.equal(features[0]?.kind, 'escapeSquaresReduced');
    assert.match(features[0]?.message ?? '', /5マスから2マス/);
});

test('新しく王手になったことを最重要として検出する', () => {
    const beforeBoard = emptyBoard();
    beforeBoard[3][0] = { type: 'OU', owner: SENTE, promoted: false };
    beforeBoard[2][1] = { type: 'KIN', owner: SENTE, promoted: false };
    beforeBoard[0][3] = { type: 'KAKU', owner: GOTE, promoted: false };

    const afterBoard = emptyBoard();
    afterBoard[3][0] = { type: 'OU', owner: SENTE, promoted: false };
    afterBoard[1][1] = { type: 'KIN', owner: SENTE, promoted: false };
    afterBoard[0][3] = { type: 'KAKU', owner: GOTE, promoted: false };

    const features = analyzeKingDanger(state(beforeBoard), state(afterBoard, GOTE));

    assert.equal(features[0]?.kind, 'checkOccurred');
    assert.equal(features[0]?.severity, 'high');
});

test('守られていない重要な自駒が取られる状態を検出する', () => {
    const board = emptyBoard();
    board[3][3] = { type: 'OU', owner: SENTE, promoted: false };
    board[2][1] = { type: 'KAKU', owner: SENTE, promoted: false };
    board[1][1] = { type: 'KIN', owner: GOTE, promoted: false };

    const features = analyzeHangingPieces(state(board, GOTE));

    assert.equal(features[0]?.kind, 'pieceHanging');
    assert.match(features[0]?.message ?? '', /角/);
});

test('局面差分の特徴は重要度順で最大3件に絞る', () => {
    const beforeBoard = emptyBoard();
    beforeBoard[3][0] = { type: 'OU', owner: SENTE, promoted: false };
    beforeBoard[2][1] = { type: 'KIN', owner: SENTE, promoted: false };
    beforeBoard[0][3] = { type: 'KAKU', owner: GOTE, promoted: false };

    const afterBoard = emptyBoard();
    afterBoard[3][0] = { type: 'OU', owner: SENTE, promoted: false };
    afterBoard[1][1] = { type: 'KIN', owner: SENTE, promoted: false };
    afterBoard[0][3] = { type: 'KAKU', owner: GOTE, promoted: false };

    const move: MoveRecord = {
        type: 'board',
        fromX: 1,
        fromY: 2,
        toX: 1,
        toY: 1,
        piece: 'KIN',
        promote: false
    };

    const features = analyzePositionDiff(state(beforeBoard), move, state(afterBoard, GOTE));

    assert.ok(features.length <= 3);
    assert.equal(features[0]?.severity, 'high');
});
