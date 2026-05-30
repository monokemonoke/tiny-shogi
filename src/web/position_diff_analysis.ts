export type Player = 'sente' | 'gote';
export type PieceKind = 'OU' | 'KIN' | 'KAKU' | 'UMA';

export type BoardPiece = {
    type: PieceKind;
    owner: Player;
    promoted?: boolean;
};

export type Board = (BoardPiece | null)[][];

export type GameStateSnapshot = {
    board: Board;
    hands: Record<Player, PieceKind[]>;
    turn: Player;
};

export type MoveRecord =
    | {
        type: 'board';
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
        piece?: PieceKind;
        promote?: boolean;
    }
    | {
        type: 'hand';
        toX: number;
        toY: number;
        piece: PieceKind;
        promote?: false;
    };

export type AnalysisFeature = {
    kind:
        | 'kingDangerIncreased'
        | 'escapeSquaresReduced'
        | 'checkOccurred'
        | 'defenderMoved'
        | 'lineOpened'
        | 'pieceHanging';
    severity: 'low' | 'medium' | 'high';
    message: string;
};

type Coord = { x: number; y: number };

const SENTE: Player = 'sente';
const GOTE: Player = 'gote';
const BOARD_SIZE = 4;

const PIECE_NAMES: Record<PieceKind, string> = {
    OU: '玉',
    KIN: '金',
    KAKU: '角',
    UMA: '馬'
};

const PLAYER_NAMES: Record<Player, string> = {
    sente: '先手',
    gote: '後手'
};

const STEP_MOVES: Record<PieceKind, number[][]> = {
    OU: [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]],
    KIN: [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1]],
    KAKU: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
    UMA: [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]
};

export function analyzePositionDiff(
    beforeState: GameStateSnapshot,
    move: MoveRecord,
    afterState: GameStateSnapshot
): AnalysisFeature[] {
    const features = [
        ...analyzeKingDanger(beforeState, afterState),
        ...analyzeEscapeSquares(beforeState, afterState),
        ...analyzeLineOpened(beforeState, move, afterState),
        ...analyzeHangingPieces(afterState, beforeState.turn)
    ];

    return sortFeatures(features).slice(0, 3);
}

export function analyzeKingDanger(
    beforeState: GameStateSnapshot,
    afterState: GameStateSnapshot
): AnalysisFeature[] {
    const owner = beforeState.turn;
    const beforeKing = findKing(beforeState.board, owner);
    const afterKing = findKing(afterState.board, owner);
    if (!beforeKing || !afterKing) return [];

    const attacker = oppositePlayer(owner);
    const beforeAttackers = countControls(beforeState.board, beforeKing, attacker);
    const afterAttackers = countControls(afterState.board, afterKing, attacker);

    if (beforeAttackers === 0 && afterAttackers > 0) {
        return [{
            kind: 'checkOccurred',
            severity: 'high',
            message: `この手で自玉に王手がかかりました。`
        }];
    }

    if (afterAttackers > beforeAttackers) {
        return [{
            kind: 'kingDangerIncreased',
            severity: afterAttackers >= 2 ? 'high' : 'medium',
            message: `この手で自玉に利いている相手の駒が${beforeAttackers}枚から${afterAttackers}枚に増えました。`
        }];
    }

    return [];
}

export function analyzeEscapeSquares(
    beforeState: GameStateSnapshot,
    afterState: GameStateSnapshot
): AnalysisFeature[] {
    const owner = beforeState.turn;
    const beforeCount = countEscapeSquares(beforeState.board, owner);
    const afterCount = countEscapeSquares(afterState.board, owner);
    if (afterCount >= beforeCount) return [];

    const decrease = beforeCount - afterCount;
    return [{
        kind: 'escapeSquaresReduced',
        severity: afterCount === 0 || decrease >= 2 ? 'high' : 'medium',
        message: `この手で自玉の逃げ道が${beforeCount}マスから${afterCount}マスに減りました。`
    }];
}

export function analyzeLineOpened(
    beforeState: GameStateSnapshot,
    move: MoveRecord,
    afterState: GameStateSnapshot
): AnalysisFeature[] {
    const owner = beforeState.turn;
    const beforeLines = findBishopLinesToKing(beforeState.board, owner);
    const afterLines = findBishopLinesToKing(afterState.board, owner);
    const opened = afterLines.find(afterLine =>
        !beforeLines.some(beforeLine =>
            beforeLine.from.x === afterLine.from.x &&
            beforeLine.from.y === afterLine.from.y
        )
    );

    if (!opened) return [];

    const movedPiece = describeMovedPiece(move);
    const prefix = movedPiece ? `${movedPiece}が動いたことで、` : 'この手で';
    return [{
        kind: 'lineOpened',
        severity: 'high',
        message: `${prefix}${PLAYER_NAMES[oppositePlayer(owner)]}の${PIECE_NAMES[opened.piece.type]}筋が自玉に通りました。`
    }];
}

export function analyzeHangingPieces(
    afterState: GameStateSnapshot,
    owner: Player = oppositePlayer(afterState.turn)
): AnalysisFeature[] {
    const attacker = oppositePlayer(owner);
    const hangingPieces: { coord: Coord; piece: BoardPiece }[] = [];

    forEachBoardPiece(afterState.board, (piece, coord) => {
        if (piece.owner !== owner || piece.type === 'OU') return;
        const attacked = countControls(afterState.board, coord, attacker) > 0;
        const defended = countControls(afterState.board, coord, owner) > 0;
        if (attacked && !defended) {
            hangingPieces.push({ coord, piece });
        }
    });

    if (hangingPieces.length === 0) return [];

    const target = hangingPieces.sort((a, b) => pieceValue(b.piece) - pieceValue(a.piece))[0];
    return [{
        kind: 'pieceHanging',
        severity: pieceValue(target.piece) >= 4 ? 'high' : 'medium',
        message: `この手のあと、${formatSquare(target.coord)}の${PIECE_NAMES[normalPieceType(target.piece)]}が守られておらず取られそうです。`
    }];
}

export function formatAnalysisFeatures(features: AnalysisFeature[]): string {
    return features.slice(0, 3).map(feature => feature.message).join('さらに、');
}

function sortFeatures(features: AnalysisFeature[]): AnalysisFeature[] {
    const severityRank: Record<AnalysisFeature['severity'], number> = {
        high: 3,
        medium: 2,
        low: 1
    };
    const kindRank: Record<AnalysisFeature['kind'], number> = {
        checkOccurred: 6,
        kingDangerIncreased: 5,
        escapeSquaresReduced: 4,
        lineOpened: 3,
        pieceHanging: 2,
        defenderMoved: 1
    };

    return [...features].sort((a, b) =>
        severityRank[b.severity] - severityRank[a.severity] ||
        kindRank[b.kind] - kindRank[a.kind]
    );
}

function countEscapeSquares(board: Board, owner: Player): number {
    const king = findKing(board, owner);
    if (!king) return 0;

    let count = 0;
    for (const [dx, dy] of STEP_MOVES.OU) {
        const to = { x: king.x + dx, y: king.y + dy };
        if (!isInside(to.x, to.y)) continue;

        const target = board[to.y][to.x];
        if (target?.owner === owner) continue;

        const simulated = cloneBoard(board);
        simulated[king.y][king.x] = null;
        simulated[to.y][to.x] = { type: 'OU', owner, promoted: false };
        if (countControls(simulated, to, oppositePlayer(owner)) === 0) {
            count++;
        }
    }

    return count;
}

function findBishopLinesToKing(board: Board, owner: Player): { from: Coord; piece: BoardPiece }[] {
    const king = findKing(board, owner);
    if (!king) return [];

    const lines: { from: Coord; piece: BoardPiece }[] = [];
    const attacker = oppositePlayer(owner);
    forEachBoardPiece(board, (piece, coord) => {
        if (piece.owner !== attacker || !isDiagonalSlider(piece)) return;
        if (isDiagonal(coord, king) && isPathClear(board, coord, king)) {
            lines.push({ from: coord, piece });
        }
    });
    return lines;
}

function countControls(board: Board, target: Coord, owner: Player): number {
    let count = 0;
    forEachBoardPiece(board, (piece, coord) => {
        if (piece.owner === owner && (coord.x !== target.x || coord.y !== target.y) &&
            pieceControlsSquare(board, coord, target)) {
            count++;
        }
    });
    return count;
}

function pieceControlsSquare(board: Board, from: Coord, target: Coord): boolean {
    const piece = board[from.y][from.x];
    if (!piece) return false;

    const type = normalPieceType(piece);
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    if (dx === 0 && dy === 0) return false;

    if (isDiagonalSlider(piece) && isDiagonal(from, target)) {
        return isPathClear(board, from, target);
    }

    return STEP_MOVES[type].some(([moveX, moveY]) => {
        const orientedX = piece.owner === SENTE ? moveX : -moveX;
        const orientedY = piece.owner === SENTE ? moveY : -moveY;
        return dx === orientedX && dy === orientedY;
    });
}

function isPathClear(board: Board, from: Coord, target: Coord): boolean {
    const stepX = Math.sign(target.x - from.x);
    const stepY = Math.sign(target.y - from.y);
    let x = from.x + stepX;
    let y = from.y + stepY;

    while (x !== target.x || y !== target.y) {
        if (board[y][x]) return false;
        x += stepX;
        y += stepY;
    }
    return true;
}

function findKing(board: Board, owner: Player): Coord | null {
    for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
            const piece = board[y][x];
            if (piece?.owner === owner && piece.type === 'OU') {
                return { x, y };
            }
        }
    }
    return null;
}

function forEachBoardPiece(
    board: Board,
    callback: (piece: BoardPiece, coord: Coord) => void
): void {
    for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
            const piece = board[y][x];
            if (piece) callback(piece, { x, y });
        }
    }
}

function normalPieceType(piece: BoardPiece): PieceKind {
    if (piece.type === 'UMA' || (piece.type === 'KAKU' && piece.promoted)) {
        return 'UMA';
    }
    return piece.type;
}

function isDiagonalSlider(piece: BoardPiece): boolean {
    const type = normalPieceType(piece);
    return type === 'KAKU' || type === 'UMA';
}

function isDiagonal(from: Coord, target: Coord): boolean {
    const dx = Math.abs(target.x - from.x);
    const dy = Math.abs(target.y - from.y);
    return dx === dy && dx > 0;
}

function oppositePlayer(player: Player): Player {
    return player === SENTE ? GOTE : SENTE;
}

function cloneBoard(board: Board): Board {
    return board.map(row => row.map(piece => piece ? { ...piece } : null));
}

function isInside(x: number, y: number): boolean {
    return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

function pieceValue(piece: BoardPiece): number {
    switch (normalPieceType(piece)) {
        case 'UMA':
            return 5;
        case 'KAKU':
            return 4;
        case 'KIN':
            return 3;
        default:
            return 0;
    }
}

function describeMovedPiece(move: MoveRecord): string {
    if (move.type !== 'board' || !move.piece) return '';
    return PIECE_NAMES[move.piece];
}

function formatSquare(coord: Coord): string {
    const ranks = ['一', '二', '三', '四'];
    return `${4 - coord.x}${ranks[coord.y]}`;
}
