// Cloudflare Workers API for minishogi analysis
// This file handles /api/analyze endpoint

// Polyfill for BigInt serialization
BigInt.prototype.toJSON = function () { return this.toString(); };

// Constants
const SENTE = 'sente';
const GOTE = 'gote';
const CONFIG = { ROWS: 4, COLS: 4 };
const PIECE_TYPES = {
    OU: { name: '王', moves: [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]] },
    KIN: { name: '金', moves: [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1]] },
    KAKU: { name: '角', moves: [[1, 1], [1, -1], [-1, 1], [-1, -1]], range: true },
    UMA: { name: '馬', moves: [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0]], range: true, slidingPart: [[1, 1], [1, -1], [-1, 1], [-1, -1]] }
};

// Hash calculation (copied from game.html)
const HashCalc = {
    calcHash(state) {
        const hash1 = this.encodeHash(state);
        const hash2 = this.encodeHashFlipped(state);
        return hash1 < hash2 ? hash1 : hash2;
    },

    encodeHash(state) {
        let hash = 0n;
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const p = state.board[y][x];
                let val = 0;
                if (p) {
                    if (p.type === 'OU') val = 1;
                    else if (p.type === 'KIN') val = 2;
                    else if (p.type === 'KAKU') val = 3;
                    if (p.promoted) val = 4;
                    if (p.owner === GOTE) val = -val;
                }
                const unsigned = BigInt(val & 0xF);
                hash |= unsigned << BigInt((y * 4 + x) * 4);
            }
        }
        const senteGold = state.hands[SENTE].filter(k => k === 'KIN').length;
        const senteBishop = state.hands[SENTE].filter(k => k === 'KAKU').length;
        const goteGold = state.hands[GOTE].filter(k => k === 'KIN').length;
        const goteBishop = state.hands[GOTE].filter(k => k === 'KAKU').length;
        hash |= BigInt(senteGold & 0xF) << 64n;
        hash |= BigInt(senteBishop & 0xF) << 68n;
        hash |= BigInt(goteGold & 0xF) << 72n;
        hash |= BigInt(goteBishop & 0xF) << 76n;
        hash |= BigInt(state.turn === SENTE ? 1 : 0) << 80n;
        return hash;
    },

    encodeHashFlipped(state) {
        let hash = 0n;
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const flippedY = 3 - y;
                const flippedX = 3 - x;
                const p = state.board[y][x];
                let val = 0;
                if (p) {
                    if (p.type === 'OU') val = 1;
                    else if (p.type === 'KIN') val = 2;
                    else if (p.type === 'KAKU') val = 3;
                    if (p.promoted) val = 4;
                    if (p.owner === SENTE) val = -val;
                    else val = val;
                }
                const unsigned = BigInt(val & 0xF);
                hash |= unsigned << BigInt((flippedY * 4 + flippedX) * 4);
            }
        }
        const senteGold = state.hands[SENTE].filter(k => k === 'KIN').length;
        const senteBishop = state.hands[SENTE].filter(k => k === 'KAKU').length;
        const goteGold = state.hands[GOTE].filter(k => k === 'KIN').length;
        const goteBishop = state.hands[GOTE].filter(k => k === 'KAKU').length;
        hash |= BigInt(goteGold & 0xF) << 64n;
        hash |= BigInt(goteBishop & 0xF) << 68n;
        hash |= BigInt(senteGold & 0xF) << 72n;
        hash |= BigInt(senteBishop & 0xF) << 76n;
        hash |= BigInt(state.turn === GOTE ? 1 : 0) << 80n;
        return hash;
    },

    hashToString(hash) {
        return hash.toString(16).toUpperCase().padStart(32, '0');
    }
};

// Shogi logic (simplified from game.html)
const ShogiLogic = {
    isPseudoLegalMove(sel, tx, ty, currentBoard) {
        if (sel.type === 'board') {
            const p = sel.piece;
            if (currentBoard[ty][tx]?.owner === p.owner) return false;
            let def = PIECE_TYPES[p.type];
            if (p.promoted && p.type === 'KAKU') def = PIECE_TYPES.UMA;
            const dx = tx - sel.x, dy = ty - sel.y;

            if (def.range) {
                const ax = Math.abs(dx), ay = Math.abs(dy);
                const signX = Math.sign(dx), signY = Math.sign(dy);
                let isSliding = false;
                if (def.slidingPart) {
                    const matchesSlide = def.slidingPart.some(m => {
                        const mx = p.owner === SENTE ? m[0] : -m[0];
                        const my = p.owner === SENTE ? m[1] : -m[1];
                        if ((mx === 0 && dx !== 0) || (my === 0 && dy !== 0)) return false;
                        if ((mx !== 0 && dx % mx !== 0) || (my !== 0 && dy % my !== 0)) return false;
                        const sx = mx !== 0 ? dx / mx : 999;
                        const sy = my !== 0 ? dy / my : 999;
                        if (sx === 999) return sy > 0; if (sy === 999) return sx > 0;
                        return sx === sy && sx > 0;
                    });
                    isSliding = matchesSlide;
                } else {
                    isSliding = (ax === ay && ax > 0);
                }

                if (isSliding) {
                    let cx = sel.x + signX, cy = sel.y + signY;
                    while (cx !== tx || cy !== ty) {
                        if (currentBoard[cy][cx] !== null) return false;
                        cx += signX; cy += signY;
                    }
                    return true;
                }
                return def.moves.some(m => {
                    const mx = p.owner === SENTE ? m[0] : -m[0];
                    const my = p.owner === SENTE ? m[1] : -m[1];
                    return dx === mx && dy === my;
                });
            } else {
                return def.moves.some(m => {
                    const mx = p.owner === SENTE ? m[0] : -m[0];
                    const my = p.owner === SENTE ? m[1] : -m[1];
                    return dx === mx && dy === my;
                });
            }
        }
        if (sel.type === 'hand') {
            if (currentBoard[ty][tx]) return false;
            return true;
        }
        return false;
    },

    isLegalMove(sel, tx, ty, owner, currentBoard) {
        if (!this.isPseudoLegalMove(sel, tx, ty, currentBoard)) return false;
        const simBoard = JSON.parse(JSON.stringify(currentBoard));
        if (sel.type === 'board') {
            const p = simBoard[sel.y][sel.x];
            simBoard[sel.y][sel.x] = null;
            simBoard[ty][tx] = p;
        } else {
            simBoard[ty][tx] = { type: sel.pKey, owner: owner, promoted: false };
        }
        return !this.isKingInCheck(simBoard, owner);
    },

    isKingInCheck(simBoard, targetOwner) {
        let kx = -1, ky = -1;
        for (let y = 0; y < CONFIG.ROWS; y++) for (let x = 0; x < CONFIG.COLS; x++) {
            const p = simBoard[y][x];
            if (p && p.owner === targetOwner && p.type === 'OU') { kx = x; ky = y; break; }
        }
        if (kx === -1) return true;
        const attacker = targetOwner === SENTE ? GOTE : SENTE;
        for (let y = 0; y < CONFIG.ROWS; y++) for (let x = 0; x < CONFIG.COLS; x++) {
            const p = simBoard[y][x];
            if (p && p.owner === attacker) {
                const sel = { type: 'board', x, y, piece: p };
                if (this.isPseudoLegalMove(sel, kx, ky, simBoard)) return true;
            }
        }
        return false;
    }
};

// Generate next states
function generateNextStates(state) {
    const nextStates = [];
    const turn = state.turn;

    for (let y = 0; y < CONFIG.ROWS; y++) {
        for (let x = 0; x < CONFIG.COLS; x++) {
            const piece = state.board[y][x];
            if (!piece || piece.owner !== turn) continue;

            for (let ty = 0; ty < CONFIG.ROWS; ty++) {
                for (let tx = 0; tx < CONFIG.COLS; tx++) {
                    const sel = { type: 'board', x, y, piece };
                    if (ShogiLogic.isLegalMove(sel, tx, ty, turn, state.board)) {
                        const canPromote = !piece.promoted && piece.type === 'KAKU' &&
                            ((turn === SENTE && (ty === 0 || y === 0)) ||
                                (turn === GOTE && (ty === 3 || y === 3)));

                        nextStates.push(applyMove(state, sel, tx, ty, false));
                        if (canPromote) {
                            nextStates.push(applyMove(state, sel, tx, ty, true));
                        }
                    }
                }
            }
        }
    }

    const hand = state.hands[turn];
    const uniquePieces = [...new Set(hand)];
    for (const pKey of uniquePieces) {
        for (let y = 0; y < CONFIG.ROWS; y++) {
            for (let x = 0; x < CONFIG.COLS; x++) {
                if (state.board[y][x]) continue;
                const idx = hand.indexOf(pKey);
                const sel = { type: 'hand', index: idx, pKey, owner: turn };
                if (ShogiLogic.isLegalMove(sel, x, y, turn, state.board)) {
                    nextStates.push(applyMove(state, sel, x, y, false));
                }
            }
        }
    }

    return nextStates;
}

function applyMove(state, moveObj, tx, ty, promote) {
    const newState = {
        board: JSON.parse(JSON.stringify(state.board)),
        hands: JSON.parse(JSON.stringify(state.hands)),
        turn: state.turn === SENTE ? GOTE : SENTE
    };

    const turn = state.turn;

    if (moveObj.type === 'board') {
        const piece = JSON.parse(JSON.stringify(moveObj.piece));
        if (promote) piece.promoted = true;

        newState.board[moveObj.y][moveObj.x] = null;

        const target = newState.board[ty][tx];
        if (target) {
            target.owner = turn;
            target.promoted = false;
            if (target.type === 'UMA') target.type = 'KAKU';
            newState.hands[turn].push(target.type);
        }

        newState.board[ty][tx] = piece;
    } else {
        newState.board[ty][tx] = { type: moveObj.pKey, owner: turn, promoted: false };
        newState.hands[turn].splice(moveObj.index, 1);
    }

    return newState;
}

// Main handler
// Main handler for POST requests
export async function onRequestPost({ request, env }) {
    // CORS headers
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    try {
        const { state } = await request.json();

        // Calculate current hash
        const currentHash = HashCalc.calcHash(state);
        const currentHashStr = HashCalc.hashToString(currentHash);

        console.log(`[Analyze] Processing hash: ${currentHashStr}`);

        if (!env.DB) {
            console.error('[Analyze] env.DB is missing!');
            throw new Error('Database binding (env.DB) is missing');
        }

        // Fetch current evaluation from D1
        let currentResult;
        try {
            currentResult = await env.DB.prepare(
                'SELECT value FROM results WHERE hash = ?'
            ).bind(currentHashStr).first();
        } catch (dbErr) {
            console.error(`[Analyze] DB Read Error for hash ${currentHashStr}:`, dbErr);
            // Re-throw with clear message
            throw new Error(`DB Read failed: ${dbErr.message}`);
        }

        const currentEval = currentResult ? JSON.parse(currentResult.value) : 'Unknown';

        // Generate next states
        const nextStates = generateNextStates(state);
        const nextHashes = nextStates.map(s => HashCalc.hashToString(HashCalc.calcHash(s)));

        // Fetch all evaluations in one query
        let moveResults = [];
        if (nextHashes.length > 0) {
            const placeholders = nextHashes.map(() => '?').join(',');
            const query = `SELECT hash, value FROM results WHERE hash IN (${placeholders})`;
            const stmt = env.DB.prepare(query).bind(...nextHashes);
            const { results } = await stmt.all();
            moveResults = results || [];
        }

        // Create hash -> result map
        const resultMap = {};
        for (const row of moveResults) {
            resultMap[row.hash] = JSON.parse(row.value);
        }

        // Build response
        const nextMoves = nextHashes.map((hash, i) => ({
            hash,
            result: resultMap[hash] || 'Unknown'
        }));

        return new Response(JSON.stringify({
            current_evaluation: currentEval,
            turn: state.turn === SENTE ? 'Sente' : 'Gote',
            hash: currentHashStr,
            next_moves: nextMoves
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// Handler for OPTIONS requests (CORS Preflight)
export async function onRequestOptions() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        }
    });
}
