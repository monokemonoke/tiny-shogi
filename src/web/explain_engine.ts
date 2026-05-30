import {
    analyzePositionDiff,
    type AnalysisFeature,
    type Board,
    type BoardPiece,
    type GameStateSnapshot,
    type MoveRecord,
    type PieceKind,
    type Player
} from './position_diff_analysis';

export type AnalyzeResponse = {
    current_evaluation: unknown;
    turn: 'Sente' | 'Gote';
    hash: string;
    next_moves: { hash: string; result: unknown }[];
};

export type ReplayStep = {
    moveNumber: number;
    move: MoveRecord;
    moveLabel: string;
    beforeState: GameStateSnapshot;
    afterState: GameStateSnapshot;
};

export type MoveExplanation = {
    moveNumber: number;
    moveLabel: string;
    features: AnalysisFeature[];
    actualResult: unknown;
    actualScore: number;
    bestScore: number;
};

const SENTE: Player = 'sente';
const GOTE: Player = 'gote';
const BOARD_SIZE = 4;

const PIECE_NAMES: Record<PieceKind, string> = {
    OU: '玉',
    KIN: '金',
    KAKU: '角',
    UMA: '馬'
};

export function initialState(): GameStateSnapshot {
    const board = emptyBoard();
    board[0][1] = { type: 'KAKU', owner: GOTE, promoted: false };
    board[0][2] = { type: 'KIN', owner: GOTE, promoted: false };
    board[0][3] = { type: 'OU', owner: GOTE, promoted: false };
    board[3][0] = { type: 'OU', owner: SENTE, promoted: false };
    board[3][1] = { type: 'KIN', owner: SENTE, promoted: false };
    board[3][2] = { type: 'KAKU', owner: SENTE, promoted: false };

    return {
        board,
        hands: { sente: [], gote: [] },
        turn: SENTE
    };
}

export function decodeKifu(encoded: string): MoveRecord[] {
    if (!encoded) return [];
    return encoded.split('-').filter(Boolean).map(decodeMove);
}

export function replayKifu(moves: MoveRecord[]): ReplayStep[] {
    const steps: ReplayStep[] = [];
    let currentState = initialState();
    let previousMove: MoveRecord | null = null;

    moves.forEach((move, index) => {
        const beforeState = cloneState(currentState);
        const applied = applyMoveRecord(currentState, move);
        const moveLabel = moveToJapanese(applied.move, previousMove ?? undefined);
        steps.push({
            moveNumber: index + 1,
            move: applied.move,
            moveLabel,
            beforeState,
            afterState: cloneState(applied.state)
        });
        currentState = applied.state;
        previousMove = applied.move;
    });

    return steps;
}

export function applyMoveRecord(
    state: GameStateSnapshot,
    move: MoveRecord
): { state: GameStateSnapshot; move: MoveRecord } {
    const nextState = cloneState(state);
    const turn = state.turn;

    if (move.type === 'board') {
        const sourcePiece = nextState.board[move.fromY]?.[move.fromX];
        if (!sourcePiece) {
            throw new Error(`移動元に駒がありません: ${move.fromX},${move.fromY}`);
        }

        const movedPiece: BoardPiece = {
            ...sourcePiece,
            promoted: move.promote ? true : sourcePiece.promoted
        };
        const target = nextState.board[move.toY][move.toX];
        if (target) {
            nextState.hands[turn].push(unpromotedType(target));
        }

        nextState.board[move.fromY][move.fromX] = null;
        nextState.board[move.toY][move.toX] = movedPiece;
        nextState.turn = oppositePlayer(turn);

        return {
            state: nextState,
            move: { ...move, piece: sourcePiece.type, promote: Boolean(move.promote) }
        };
    }

    nextState.board[move.toY][move.toX] = {
        type: move.piece,
        owner: turn,
        promoted: false
    };
    const handIndex = nextState.hands[turn].indexOf(move.piece);
    if (handIndex >= 0) {
        nextState.hands[turn].splice(handIndex, 1);
    }
    nextState.turn = oppositePlayer(turn);

    return { state: nextState, move: { ...move, promote: false } };
}

export function explainMoveIfBad(
    beforeState: GameStateSnapshot,
    move: MoveRecord,
    afterState: GameStateSnapshot,
    analysis: AnalyzeResponse,
    moveNumber: number,
    moveLabel: string
): MoveExplanation | null {
    const actualHash = hashState(afterState);
    const actualMove = analysis.next_moves.find(candidate => candidate.hash === actualHash);
    const actualScore = scoreMoveResult(actualMove?.result);
    if (actualScore === null) return null;

    const scores = analysis.next_moves
        .map(candidate => scoreMoveResult(candidate.result))
        .filter((score): score is number => score !== null);
    if (scores.length === 0) return null;

    const bestScore = Math.max(...scores);
    if (actualScore >= bestScore) return null;

    return {
        moveNumber,
        moveLabel,
        features: analyzePositionDiff(beforeState, move, afterState),
        actualResult: actualMove?.result,
        actualScore,
        bestScore
    };
}

export function moveToJapanese(move: MoveRecord, previousMove?: MoveRecord): string {
    const fileNums = ['１', '２', '３', '４'];
    const ranks = ['一', '二', '三', '四'];
    const col = 4 - move.toX;
    const row = move.toY + 1;
    const coord = previousMove?.toX === move.toX && previousMove?.toY === move.toY
        ? '同'
        : `${fileNums[col - 1] || col}${ranks[row - 1] || row}`;

    if (move.type === 'hand') {
        return `${coord}${PIECE_NAMES[move.piece]}打`;
    }

    const pieceName = move.piece ? PIECE_NAMES[move.piece] : '?';
    return `${coord}${pieceName}${move.promote ? '成' : ''}`;
}

export function hashState(state: GameStateSnapshot): string {
    const hash = calcHash(state);
    return hash.toString(16).toUpperCase().padStart(32, '0');
}

export function scoreMoveResult(result: unknown): number | null {
    if (result && typeof result === 'object') {
        const value = result as { Win?: unknown; Lose?: unknown; Draw?: unknown; Sennichite?: unknown };
        if (typeof value.Lose === 'number') return 100000 - value.Lose;
        if (typeof value.Win === 'number') return -100000 + value.Win;
        if (value.Draw !== undefined || value.Sennichite !== undefined) return 0;
    }
    if (result === 'Draw' || result === 'Sennichite' || result === '千日手') return 0;
    return null;
}

function decodeMove(encoded: string): MoveRecord {
    if (/^[A-Z]/.test(encoded)) {
        const piece = charToPiece(encoded[0]);
        const to = strToCoord(encoded.substring(1, 3));
        return { type: 'hand', toX: to.x, toY: to.y, piece, promote: false };
    }

    const from = strToCoord(encoded.substring(0, 2));
    const to = strToCoord(encoded.substring(2, 4));
    return {
        type: 'board',
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        promote: encoded.includes('+')
    };
}

function strToCoord(value: string): { x: number; y: number } {
    const col = parseInt(value[0], 10);
    const row = parseInt(value[1], 10);
    return { x: 4 - col, y: row - 1 };
}

function charToPiece(value: string): PieceKind {
    switch (value) {
        case 'O':
            return 'OU';
        case 'G':
            return 'KIN';
        case 'K':
            return 'KAKU';
        default:
            return 'OU';
    }
}

function calcHash(state: GameStateSnapshot): bigint {
    const hash = encodeHash(state);
    const flippedHash = encodeHashFlipped(state);
    return hash < flippedHash ? hash : flippedHash;
}

function encodeHash(state: GameStateSnapshot): bigint {
    let hash = 0n;

    for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
            const piece = state.board[y][x];
            let value = pieceValueForHash(piece);
            if (piece?.owner === GOTE) value = -value;
            hash |= BigInt(value & 0xF) << BigInt((y * BOARD_SIZE + x) * 4);
        }
    }

    hash |= BigInt(countHand(state, SENTE, 'KIN') & 0xF) << 64n;
    hash |= BigInt(countHand(state, SENTE, 'KAKU') & 0xF) << 68n;
    hash |= BigInt(countHand(state, GOTE, 'KIN') & 0xF) << 72n;
    hash |= BigInt(countHand(state, GOTE, 'KAKU') & 0xF) << 76n;
    hash |= BigInt(state.turn === SENTE ? 1 : 0) << 80n;

    return hash;
}

function encodeHashFlipped(state: GameStateSnapshot): bigint {
    let hash = 0n;

    for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
            const flippedY = BOARD_SIZE - 1 - y;
            const flippedX = BOARD_SIZE - 1 - x;
            const piece = state.board[y][x];
            let value = pieceValueForHash(piece);
            if (piece?.owner === SENTE) value = -value;
            hash |= BigInt(value & 0xF) << BigInt((flippedY * BOARD_SIZE + flippedX) * 4);
        }
    }

    hash |= BigInt(countHand(state, GOTE, 'KIN') & 0xF) << 64n;
    hash |= BigInt(countHand(state, GOTE, 'KAKU') & 0xF) << 68n;
    hash |= BigInt(countHand(state, SENTE, 'KIN') & 0xF) << 72n;
    hash |= BigInt(countHand(state, SENTE, 'KAKU') & 0xF) << 76n;
    hash |= BigInt(state.turn === GOTE ? 1 : 0) << 80n;

    return hash;
}

function pieceValueForHash(piece: BoardPiece | null): number {
    if (!piece) return 0;
    if (piece.promoted || piece.type === 'UMA') return 4;
    if (piece.type === 'OU') return 1;
    if (piece.type === 'KIN') return 2;
    if (piece.type === 'KAKU') return 3;
    return 0;
}

function countHand(state: GameStateSnapshot, owner: Player, piece: PieceKind): number {
    return state.hands[owner].filter(item => item === piece).length;
}

function emptyBoard(): Board {
    return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

function cloneState(state: GameStateSnapshot): GameStateSnapshot {
    return {
        board: state.board.map(row => row.map(piece => piece ? { ...piece } : null)),
        hands: {
            sente: [...state.hands.sente],
            gote: [...state.hands.gote]
        },
        turn: state.turn
    };
}

function unpromotedType(piece: BoardPiece): PieceKind {
    return piece.type === 'UMA' ? 'KAKU' : piece.type;
}

function oppositePlayer(player: Player): Player {
    return player === SENTE ? GOTE : SENTE;
}
