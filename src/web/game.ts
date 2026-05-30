import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { Tween, Easing, Group } from '@tweenjs/tween.js';
import html2canvas from 'html2canvas';

// TWEEN v25 では明示的な Group が必要
const tweenGroup = new Group();

// --- Constants & Config ---
const CONFIG: any = {
    ROWS: 4, COLS: 4, CELL_SIZE: 2.0, BOARD_PADDING: 0.8,
    BOARD_THICKNESS: 1.5, TABLE_HEIGHT: 1.2
};
CONFIG.GRID_WIDTH = CONFIG.COLS * CONFIG.CELL_SIZE;
CONFIG.GRID_HEIGHT = CONFIG.ROWS * CONFIG.CELL_SIZE;
CONFIG.BOARD_WIDTH = CONFIG.GRID_WIDTH + CONFIG.BOARD_PADDING * 2;
CONFIG.BOARD_HEIGHT = CONFIG.GRID_HEIGHT + CONFIG.BOARD_PADDING * 2;

const SENTE = 'sente', GOTE = 'gote';
const ASSET_BASE_URL = (() => {
    const base = ((import.meta as any).env?.BASE_URL ?? '/') as string;
    return base.endsWith('/') ? base : `${base}/`;
})();
const assetUrl = (fileName: string) => `${ASSET_BASE_URL}assets/${fileName}`;
const PIECE_TYPES = {
    OU: { name: '王', moves: [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]] },
    KIN: { name: '金', moves: [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1]] },
    KAKU: { name: '角', moves: [[1, 1], [1, -1], [-1, 1], [-1, -1]], range: true },
    UMA: { name: '馬', moves: [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0]], range: true, slidingPart: [[1, 1], [1, -1], [-1, 1], [-1, -1]] }
};

type RawSolve = { Win: number } | { Lose: number } | 'Unknown' | 'Draw' | 'Sennichite';
type SolveValue =
    | { kind: 'sente_win'; ply: number }
    | { kind: 'gote_win'; ply: number }
    | { kind: 'draw' }
    | { kind: 'unknown' };
type EvalDisplay = {
    senteWinRate: number | null;
    solveLabel: string;
    headlineLabel: string;
};
interface WinRateMapper {
    toPercentFromPly(ply: number): number;
}

class LogisticWinRateMapper implements WinRateMapper {
    constructor(private readonly k: number, private readonly b: number) {}

    toPercentFromPly(ply: number): number {
        // Map to winning-side confidence in [50, 100].
        // Smaller ply -> closer to 100, larger ply -> closer to 50.
        const raw = 50 + 50 / (1 + Math.exp(this.k * (ply - this.b)));
        return Math.max(50, Math.min(100, raw));
    }
}

function parseRawSolve(raw: any, turn: string): SolveValue {
    if (raw === 'Unknown' || raw === null || raw === undefined) {
        return { kind: 'unknown' };
    }
    if (raw === 'Draw' || raw === 'Sennichite' || raw === '千日手') {
        return { kind: 'draw' };
    }
    if (typeof raw === 'object') {
        if (raw.Draw !== undefined || raw.Sennichite !== undefined) {
            return { kind: 'draw' };
        }
        if (typeof raw.Win === 'number') {
            return turn === SENTE
                ? { kind: 'sente_win', ply: raw.Win }
                : { kind: 'gote_win', ply: raw.Win };
        }
        if (typeof raw.Lose === 'number') {
            return turn === SENTE
                ? { kind: 'gote_win', ply: raw.Lose }
                : { kind: 'sente_win', ply: raw.Lose };
        }
    }
    return { kind: 'unknown' };
}

function buildEvalDisplay(solve: SolveValue, mapper: WinRateMapper): EvalDisplay {
    switch (solve.kind) {
        case 'sente_win': {
            const senteWinRate = mapper.toPercentFromPly(solve.ply);
            return {
                senteWinRate,
                solveLabel: `先手 ${solve.ply} 手勝ち`,
                headlineLabel: `先手 ${Math.round(senteWinRate)}%`
            };
        }
        case 'gote_win': {
            const senteWinRate = 100 - mapper.toPercentFromPly(solve.ply);
            return {
                senteWinRate,
                solveLabel: `後手 ${solve.ply} 手勝ち`,
                headlineLabel: `先手 ${Math.round(senteWinRate)}%`
            };
        }
        case 'draw':
            return {
                senteWinRate: 50,
                solveLabel: '千日手',
                headlineLabel: '先手 50%'
            };
        default:
            return {
                senteWinRate: 50,
                solveLabel: '厳密値不明',
                headlineLabel: '先手 50%'
            };
    }
}

// --- State ---
const GameState: any = {
    board: [],
    hands: { [SENTE]: [], [GOTE]: [] },
    turn: SENTE,
    history: [],
    moveRecords: [], // Kifu diffs
    redoStack: [],   // Future states for redo
    redoMoves: [],   // Future moves for redo
    selected: null,
    reviewMode: false,
    reviewIndex: -1, // -1 means latest (or live)
    reset() {
        this.board = Array.from({ length: CONFIG.ROWS }, () => Array(CONFIG.COLS).fill(null));
        this.hands = { [SENTE]: [], [GOTE]: [] };
        this.turn = SENTE;
        this.selected = null;
        this.history = [];
        this.moveRecords = [];
        this.redoStack = [];
        this.redoMoves = [];
        this.reviewMode = false;
        this.reviewIndex = -1;
    }
};

// --- Kifu Codec ---
const KifuCodec = {
    coordToStr(x: number, y: number): string {
        const col = 4 - x;
        const row = y + 1;
        return "" + col + row;
    },
    strToCoord(s: string): { x: number, y: number } {
        const col = parseInt(s[0]);
        const row = parseInt(s[1]);
        return { x: 4 - col, y: row - 1 };
    },
    pieceToChar(type: string): string {
        switch (type) {
            case 'OU': return 'O';
            case 'KIN': return 'G';
            case 'KAKU': return 'K';
            case 'UMA': return 'K'; // UMA is K + promote
            case 'GIN': return 'S';
            case 'HISHA': return 'H';
            case 'FU': return 'P';
            default: return '?';
        }
    },
    charToPiece(c: string): string {
        switch (c) {
            case 'O': return 'OU';
            case 'G': return 'KIN';
            case 'K': return 'KAKU';
            case 'S': return 'GIN';
            case 'H': return 'HISHA';
            case 'P': return 'FU';
            default: return 'OU';
        }
    },
    encodeMove(move: any): string {
        if (move.type === 'board') {
            let s = this.coordToStr(move.fromX, move.fromY) + this.coordToStr(move.toX, move.toY);
            if (move.promote) s += "+";
            return s;
        } else {
            return this.pieceToChar(move.piece) + this.coordToStr(move.toX, move.toY);
        }
    },
    decodeMove(s: string): any {
        if (/^[A-Z]/.test(s)) {
            const piece = this.charToPiece(s[0]);
            const to = this.strToCoord(s.substring(1, 3));
            return { type: 'hand', toX: to.x, toY: to.y, piece: piece };
        } else {
            const from = this.strToCoord(s.substring(0, 2));
            const to = this.strToCoord(s.substring(2, 4));
            const promote = s.includes("+");
            return { type: 'board', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, promote: promote };
        }
    },
    encode(moves: any[]): string {
        return moves.map(m => this.encodeMove(m)).join("-");
    },
    decode(s: string): any[] {
        if (!s) return [];
        return s.split("-").map(part => this.decodeMove(part));
    },
    // 日本語棋譜表記に変換
    moveToJapanese(move: any, prevMove?: any): string {
        const fileNums = ['１', '２', '３', '４'];
        const ranks = ['一', '二', '三', '四'];
        const pieceNames: Record<string, string> = { 'OU': '玉', 'KIN': '金', 'KAKU': '角', 'UMA': '馬' };
        const col = 4 - move.toX;
        const row = move.toY + 1;
        const coord = (prevMove && prevMove.toX === move.toX && prevMove.toY === move.toY)
            ? '同'
            : `${fileNums[col - 1] || col}${ranks[row - 1] || row}`;
        const pieceName = pieceNames[move.piece] || '?';

        if (move.type === 'hand') {
            return `${coord}${pieceName}打`;
        }
        const promote = move.promote ? '成' : '';
        return `${coord}${pieceName}${promote}`;
    }
};

// --- Logic Wrapper ---
const ShogiLogic = {
    initBoard(state) {
        state.reset();
        state.board[0][1] = { type: 'KAKU', owner: GOTE, promoted: false };
        state.board[0][2] = { type: 'KIN', owner: GOTE, promoted: false };
        state.board[0][3] = { type: 'OU', owner: GOTE, promoted: false };
        state.board[3][0] = { type: 'OU', owner: SENTE, promoted: false };
        state.board[3][1] = { type: 'KIN', owner: SENTE, promoted: false };
        state.board[3][2] = { type: 'KAKU', owner: SENTE, promoted: false };
    },

    // Simple validation derived from game.html
    isPseudoLegalMove(sel, tx, ty, currentBoard) {
        // Simplified for brevity, assumes game.html logic is correct.
        // Re-implementing critical parts for UI interaction
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
                    // Horse check
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
                // Step part
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

        // Simulation
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

// --- Hash Calculation (Rust compatible) ---
const HashCalc = {
    // Convert GameState to Rust-compatible format and calculate hash
    calcHash(state) {
        const hash1 = this.encodeHash(state);
        const hash2 = this.encodeHashFlipped(state);
        return hash1 < hash2 ? hash1 : hash2;
    },

    encodeHash(state) {
        let hash = 0n;

        // Board: 4x4 grid, 4 bits per cell
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const p = state.board[y][x];
                let val = 0;
                if (p) {
                    if (p.type === 'OU') val = 1;
                    else if (p.type === 'KIN') val = 2;
                    else if (p.type === 'KAKU') val = 3;
                    if (p.promoted) val = 4; // Horse
                    if (p.owner === GOTE) val = -val;
                }
                // Convert to unsigned 4-bit
                const unsigned = BigInt(val & 0xF);
                hash |= unsigned << BigInt((y * 4 + x) * 4);
            }
        }

        // Hands: sente[0], sente[1], gote[0], gote[1]
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

        // Flip board 180 degrees and negate pieces
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
                    if (p.owner === SENTE) val = -val; // Flip owner
                    else val = val; // Gote becomes positive
                }
                const unsigned = BigInt(val & 0xF);
                hash |= unsigned << BigInt((flippedY * 4 + flippedX) * 4);
            }
        }

        // Swap hands
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

    // Convert BigInt hash to 32-char hex string (uppercase, zero-padded)
    hashToString(hash) {
        return hash.toString(16).toUpperCase().padStart(32, '0');
    }
};

// --- View (Simplified from game.html) ---
const ShogiView = {
    scene: null as any, camera: null as any, renderer: null as any, cssRenderer: null as any,
    raycaster: null as any, mouse: null as any,
    meshes: { board: [], pieces: [], hands: [], komadai: { sente: null, gote: null } } as any,
    isMobile: false,


    init() {
        this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x000000);
        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
        // Initial position set by playStartAnimation later
        // But set a default just in case
        this.camera.position.set(0, 18, 14); this.camera.lookAt(0, -1, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true; this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        document.body.appendChild(this.renderer.domElement);

        this.cssRenderer = new CSS3DRenderer();
        this.cssRenderer.setSize(window.innerWidth, window.innerHeight);
        this.cssRenderer.domElement.style.position = 'absolute'; this.cssRenderer.domElement.style.top = 0;
        this.cssRenderer.domElement.style.pointerEvents = 'none';
        document.body.appendChild(this.cssRenderer.domElement);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const dl = new THREE.DirectionalLight(0xffffff, 1.3); dl.position.set(5, 15, 10); dl.castShadow = true;
        this.scene.add(dl);

        this.raycaster = new THREE.Raycaster(); this.mouse = new THREE.Vector2();

        this.createEnvironment();
        this.createClickableGrid();

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight; this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight); this.cssRenderer.setSize(window.innerWidth, window.innerHeight);
            this.updateLayout();
        });
        window.addEventListener('pointerdown', (e) => Main.onPointerDown(e));

        this.updateLayout(); // Initial layout
        this.animate();
    },

    updateLayout() {
        // Shared mobile detection logic
        const wasMobile = this.isMobile;
        this.isMobile = (window.innerWidth < 768) || (window.innerWidth / window.innerHeight < 0.9);

        // Reposition Komadai
        const w = 4.0; 
        const d = 6.0; // Komadai dimensions
        // Desktop: Side by Side
        // Mobile: Front and Back (Sente Bottom, Gote Top)
        
        if (this.meshes.komadai.sente && this.meshes.komadai.gote) {
            this.meshes.komadai.sente.scale.set(1, 1, 1);
            this.meshes.komadai.gote.scale.set(1, 1, 1);

            if (this.isMobile) {
                 // Mobile: Sente at Bottom (+Z), Gote at Top (-Z)
                 // Scale Z (which becomes Global X) to match board width
                 const scaleZ = CONFIG.BOARD_WIDTH / d;
                 this.meshes.komadai.sente.scale.z = scaleZ;
                 this.meshes.komadai.gote.scale.z = scaleZ;

                 const zOffset = CONFIG.BOARD_HEIGHT / 2 + 2.0 + 0.5;
                 
                 // Sente Stand (Bottom)
                 this.meshes.komadai.sente.position.set(0, -CONFIG.BOARD_THICKNESS + CONFIG.TABLE_HEIGHT / 2, zOffset);
                 this.meshes.komadai.sente.rotation.y = Math.PI / 2;
                 
                 // Gote Stand (Top)
                 this.meshes.komadai.gote.position.set(0, -CONFIG.BOARD_THICKNESS + CONFIG.TABLE_HEIGHT / 2, -zOffset);
                 this.meshes.komadai.gote.rotation.y = Math.PI / 2;
                 
            } else {
                // Desktop: Sente Right (+X), Gote Left (-X)
                const xOffset = CONFIG.BOARD_WIDTH / 2 + w / 2 + 0.5;
                
                this.meshes.komadai.sente.position.set(xOffset, -CONFIG.BOARD_THICKNESS + CONFIG.TABLE_HEIGHT / 2, 1);
                this.meshes.komadai.sente.rotation.y = 0;

                this.meshes.komadai.gote.position.set(-xOffset, -CONFIG.BOARD_THICKNESS + CONFIG.TABLE_HEIGHT / 2, -1);
                this.meshes.komadai.gote.rotation.y = 0;
            }
        }

        if (wasMobile !== this.isMobile) {
             // Re-render hands if layout changed
             ShogiView.render(GameState);
             const main = (window as any).Main;
             if (main?.handleMobileLayoutChange) {
                 main.handleMobileLayoutChange(this.isMobile);
             }
        }
    },

    createEnvironment() {
        const tatami = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: this.createTexture('tatami'), roughness: 0.8 }));
        tatami.rotation.x = -Math.PI / 2; tatami.position.y = -CONFIG.BOARD_THICKNESS - 0.1; tatami.receiveShadow = true; this.scene.add(tatami);
        const wTex = this.createTexture('wood_light');
        const mats = Array(6).fill(null).map((_, i) => new THREE.MeshStandardMaterial({ map: i === 2 ? this.createTexture('grid') : wTex, roughness: 0.2, metalness: 0.05 }));
        const boardMesh = new THREE.Mesh(new THREE.BoxGeometry(CONFIG.BOARD_WIDTH, CONFIG.BOARD_THICKNESS, CONFIG.BOARD_HEIGHT), mats);
        boardMesh.position.set(0, -CONFIG.BOARD_THICKNESS / 2, 0); boardMesh.castShadow = true; boardMesh.receiveShadow = true; this.scene.add(boardMesh);

        const dTex = this.createTexture('wood_dark'); const tMat = new THREE.MeshStandardMaterial({ map: dTex, roughness: 0.2, metalness: 0.05 });
        const w = 4.0, d = 6.0;
        
        // Initial positions will be set by updateLayout, just create meshes here
        const mkS = new THREE.Mesh(new THREE.BoxGeometry(w, CONFIG.TABLE_HEIGHT, d), tMat);
        mkS.castShadow = true; mkS.receiveShadow = true; this.scene.add(mkS);
        this.meshes.komadai.sente = mkS;

        const mkG = new THREE.Mesh(new THREE.BoxGeometry(w, CONFIG.TABLE_HEIGHT, d), tMat);
        mkG.castShadow = true; mkG.receiveShadow = true; this.scene.add(mkG);
        this.meshes.komadai.gote = mkG;
    },

    createTexture(type) {
        if (type === 'tatami') {
            const c = document.createElement('canvas'); c.width = 256; c.height = 256; const ctx = c.getContext('2d')!;
            ctx.fillStyle = "#c8c290"; ctx.fillRect(0, 0, 256, 256);
            ctx.fillStyle = "#b8b280"; for (let y = 0; y < 256; y += 4) if ((y / 4) % 2 === 0) ctx.fillRect(0, y, 256, 2);
            ctx.fillStyle = "#2d4536"; ctx.fillRect(0, 0, 10, 256); ctx.fillRect(246, 0, 10, 256);
            const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 8); t.colorSpace = THREE.SRGBColorSpace; return t;
        } else if (type === 'grid') {
            const cw = 1024, ch = Math.round(cw * (CONFIG.BOARD_HEIGHT / CONFIG.BOARD_WIDTH));
            const c = document.createElement('canvas'); c.width = cw; c.height = ch; const ctx = c.getContext('2d')!;
            ctx.fillStyle = "#D7A55F"; ctx.fillRect(0, 0, cw, ch);
            ctx.globalAlpha = 0.15; ctx.fillStyle = "#8d6e63"; for (let i = 0; i < 300; i++) ctx.fillRect(Math.random() * cw, 0, Math.random() * 5 + 2, ch);
            ctx.globalAlpha = 1.0;
            const dw = cw * (CONFIG.GRID_WIDTH / CONFIG.BOARD_WIDTH), dh = ch * (CONFIG.GRID_HEIGHT / CONFIG.BOARD_HEIGHT);
            const mx = (cw - dw) / 2, my = (ch - dh) / 2;
            ctx.strokeStyle = "#111"; ctx.lineWidth = 5; ctx.beginPath();
            const sx = dw / CONFIG.COLS, sy = dh / CONFIG.ROWS;
            for (let i = 1; i < CONFIG.COLS; i++) { ctx.moveTo(mx + i * sx, my); ctx.lineTo(mx + i * sx, my + dh); }
            for (let i = 1; i < CONFIG.ROWS; i++) { ctx.moveTo(mx, my + i * sy); ctx.lineTo(mx + dw, my + i * sy); }
            ctx.stroke(); ctx.strokeRect(mx, my, dw, dh);
            const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
        } else {
            const c = document.createElement('canvas'); c.width = 512; c.height = 512; const ctx = c.getContext('2d')!;
            ctx.fillStyle = type === 'wood_dark' ? '#5d4037' : '#D7A55F'; ctx.fillRect(0, 0, 512, 512);
            ctx.globalAlpha = 0.1; ctx.fillStyle = type === 'wood_dark' ? '#3e2723' : '#B08040';
            for (let i = 0; i < 100; i++) ctx.fillRect(Math.random() * 512, 0, Math.random() * 50 + 10, 512);
            const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
        }
    },

    createClickableGrid() {
        const g = new THREE.BoxGeometry(CONFIG.CELL_SIZE * 0.95, 0.1, CONFIG.CELL_SIZE * 0.95);
        const m = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0 });
        const ox = (CONFIG.COLS - 1) * CONFIG.CELL_SIZE / 2, oz = (CONFIG.ROWS - 1) * CONFIG.CELL_SIZE / 2;
        for (let y = 0; y < CONFIG.ROWS; y++) for (let x = 0; x < CONFIG.COLS; x++) {
            const t = new THREE.Mesh(g, m.clone());
            t.position.set(x * CONFIG.CELL_SIZE - ox, 0.05, y * CONFIG.CELL_SIZE - oz);
            t.userData = { isBoard: true, x, y }; this.scene.add(t); this.meshes.board.push(t);
        }
    },

    render(state) {
        this.meshes.pieces.forEach(g => { this.scene.remove(g); this.cleanupObj(g); }); this.meshes.pieces = [];
        this.meshes.hands.forEach(g => { this.scene.remove(g); this.cleanupObj(g); }); this.meshes.hands = [];
        this.meshes.board.forEach(m => m.material.opacity = 0);

        const ox = (CONFIG.COLS - 1) * CONFIG.CELL_SIZE / 2, oz = (CONFIG.ROWS - 1) * CONFIG.CELL_SIZE / 2;
        for (let y = 0; y < CONFIG.ROWS; y++) for (let x = 0; x < CONFIG.COLS; x++) {
            const p = state.board[y][x];
            if (p) {
                const g = this.createPieceObject(p);
                g.position.set(x * CONFIG.CELL_SIZE - ox, 0, y * CONFIG.CELL_SIZE - oz);
                if (p.owner === GOTE) g.rotation.y = Math.PI;
                if (state.selected && state.selected.type === 'board' && state.selected.x === x && state.selected.y === y) {
                    g.position.y += 0.3; ((g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0x664422);
                }
                g.userData = { type: 'board', x, y, piece: p };
                this.scene.add(g); this.meshes.pieces.push(g);
            }
        }
        this.drawHand(SENTE, state); this.drawHand(GOTE, state);
        if (state.selected) this.highlightLegalMoves(state);
    },

    drawHand(owner, state) {
        const isS = owner === SENTE; const yPos = -CONFIG.BOARD_THICKNESS + CONFIG.TABLE_HEIGHT;
        const hand = state.hands[owner];
        
        // Get Komadai position
        let kX = 0, kZ = 0;
        if (isS && this.meshes.komadai.sente) {
             kX = this.meshes.komadai.sente.position.x;
             kZ = this.meshes.komadai.sente.position.z;
        } else if (!isS && this.meshes.komadai.gote) {
             kX = this.meshes.komadai.gote.position.x;
             kZ = this.meshes.komadai.gote.position.z;
        }

        hand.forEach((k, i) => {
            const g = this.createPieceObject({ type: k, owner: owner, promoted: false });
            
            let lx, lz;
            
            if (this.isMobile) {
                // Rotated stand
                // Width extended to align with board width ~CONFIG.BOARD_WIDTH
                // Piece width ~1.5
                const cols = 6; // Fits ~9.0 width
                const col = i % cols;
                const row = Math.floor(i / cols);
                
                lx = (col - (cols - 1) / 2) * 1.5;
                lz = (row - 0.5) * 1.5; 
            } else {
                // Desktop: Width 4.0, Depth 6.0
                // 2 columns
                const cols = 2;
                const col = i % cols;
                const row = Math.floor(i / cols);
                
                lx = (col - 0.5) * 1.5;
                lz = (row - 1.0) * 1.5; 
            }

            g.position.set(kX + lx, yPos, kZ + lz);

            if (owner === GOTE) g.rotation.y = Math.PI;
            if (state.selected && state.selected.type === 'hand' && state.selected.owner === owner && state.selected.index === i) {
                g.position.y += 0.3; ((g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0x664422);
            }
            g.userData = { type: 'hand', index: i, pKey: k, owner: owner };
            this.scene.add(g); this.meshes.hands.push(g);
        });
    },

    highlightLegalMoves(state) {
        for (let y = 0; y < CONFIG.ROWS; y++) for (let x = 0; x < CONFIG.COLS; x++) {
            if (ShogiLogic.isLegalMove(state.selected, x, y, state.turn, state.board)) {
                const mesh = this.meshes.board.find(m => m.userData.x === x && m.userData.y === y);
                if (mesh) mesh.material.opacity = 0.5;
            }
        }
    },

    createPieceObject(p) {
        const g = new THREE.Group();

        // 1. Create Hitbox (Invisible, larger for easier clicking)
        // Piece is approx 1.5x1.5. Thickness ~0.5.
        // Make hitbox slightly larger: 1.6 x 1.6 x 1.0 (extra height)
        const hitGeo = new THREE.BoxGeometry(1.6, 1.0, 1.6);
        const hitMat = new THREE.MeshBasicMaterial({ color: 0xff0000, visible: false }); // Invisible
        const hitBox = new THREE.Mesh(hitGeo, hitMat);
        hitBox.position.y = 0.25; // Centered slightly up
        g.add(hitBox); // Add as first child for raycaster targeting

        const s = new THREE.Shape();
        s.moveTo(0, 0.9); s.lineTo(0.75, 0.4); s.lineTo(0.75 * 1.1, -0.9); s.lineTo(-0.75 * 1.1, -0.9); s.lineTo(-0.75, 0.4); s.lineTo(0, 0.9);
        const geo = new THREE.ExtrudeGeometry(s, { depth: 0.45, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3 });
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) if (pos.getZ(i) > 0.05) pos.setZ(i, pos.getZ(i) * Math.max(0.1, 1.0 - ((pos.getY(i) + 0.9) * 0.25)));
        geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(255 / 255, 174 / 255, 88 / 255), roughness: 0.4, metalness: 0.1 }));
        m.rotation.x = -Math.PI / 2; m.castShadow = true; m.receiveShadow = true; g.add(m);

        let t = PIECE_TYPES[p.type].name;
        if (p.type === 'OU' && p.owner === SENTE) t = '玉';
        if (p.promoted) { if (p.type === 'KAKU') t = '馬'; else t = '全'; }
        const d = document.createElement('div'); d.className = 'piece-text';
        if (p.promoted) d.classList.add('promoted-text'); d.textContent = t;
        const c = new CSS3DObject(d); c.scale.set(0.007, 0.007, 0.007); c.position.set(0, 0.36, 0.1); c.rotation.x = -Math.PI / 2 - 0.15;
        g.add(c); return g;
    },

    cleanupObj(g) {
        g.traverse(c => {
            if (c.geometry) c.geometry.dispose();
            if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose());
            if (c.element && c.element.parentNode) c.element.parentNode.removeChild(c.element);
        });
    },

    playStartAnimation() {
        this.camera.position.set(0, 18, 14);
        this.camera.lookAt(0, -1, 0);
        
        // Local detection since we don't have full responsive logic ported yet
        // Simplified to use shared state or recalc
        const targetPos = this.isMobile ? { x: 0, y: 22, z: 2 } : { x: 0, y: 12.5, z: 3 };
        
        new Tween(this.camera.position, tweenGroup)
            .to(targetPos, 1500)
            .easing(Easing.Cubic.InOut)
            .onUpdate(() => { this.camera.lookAt(0, -1, 0); })
            .start();
    },

    animate(t = 0) {
        requestAnimationFrame((time) => this.animate(time));



        tweenGroup.update(t);
        this.renderer.render(this.scene, this.camera);
        this.cssRenderer.render(this.scene, this.camera);
    }
};

// --- Main Controller & API Client ---
const Main: any = {
    uiState: 'open',
    winRateMapper: new LogisticWinRateMapper(0.2, 25),
    currentEvalDisplay: null as EvalDisplay | null,
    gameOverGraphHoverIndex: null as number | null,
    hasPlayedWelcomeSound: false,

    init() {
        this.initSounds();
        this.updateSoundBtn();

        ShogiLogic.initBoard(GameState);
        ShogiView.init();
        ShogiView.render(GameState);
        
        // URL Load
        this.loadFromURL();

        if (!GameState.reviewMode && !(window as any).__sprintMode) {
             this.analyze();
        }

        this.currentEvalDisplay = buildEvalDisplay({ kind: 'unknown' }, this.winRateMapper);
        this.renderEvaluationSummary();
        
        this.updateReviewUI();
        this.updateKifuList();
        ShogiView.playStartAnimation();

        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.undoMove();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.redoMove();
            }
        });
    },



    loadFromURL() {
        const params = new URLSearchParams(window.location.search);
        const m = params.get('m');
        if (!m) return;
        const moves = KifuCodec.decode(m);
        for (const move of moves) {
            this.commitMoveInternal(move, true);
        }
        ShogiView.render(GameState);
    },

    enterReviewMode(moves) {
       // Functionality removed
    },

    updateURL() {
        const encoded = KifuCodec.encode(GameState.moveRecords);
        const url = new URL(window.location.href);
        if (encoded) {
            url.searchParams.set('m', encoded);
        } else {
            url.searchParams.delete('m');
        }
        history.replaceState(null, '', url.toString());
    },

    startGame() {
        // No-op: Overlay removed
    },

    onPointerDown(e) {
        if (!this.hasPlayedWelcomeSound) {
            this.playSound('yorosiku');
            this.hasPlayedWelcomeSound = true;
        }

        // 振り返りモード中は操作無効
        if (GameState.reviewMode) return;
        
        if (e.target.closest('#ui-container') || 
            (document.getElementById('promotion-overlay') && document.getElementById('promotion-overlay')!.style.display === 'flex')) return;

        // Map simplified logic
        ShogiView.mouse.x = (e.clientX / window.innerWidth) * 2 - 1; ShogiView.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        ShogiView.raycaster.setFromCamera(ShogiView.mouse, ShogiView.camera);
        const targets = [...ShogiView.meshes.pieces, ...ShogiView.meshes.hands].map(g => g.children[0]).concat(ShogiView.meshes.board);
        const intersects = ShogiView.raycaster.intersectObjects(targets);

        if (intersects.length > 0) {
            let hit = intersects[0].object;
            let d = hit.parent && hit.parent.userData.type ? hit.parent.userData : hit.userData;

            if ((d.type === 'board' && d.piece.owner === GameState.turn) || (d.type === 'hand' && d.owner === GameState.turn)) {
                GameState.selected = (GameState.selected && this.isSameSelection(GameState.selected, d)) ? null : d;
                ShogiView.render(GameState);
            } else if (GameState.selected) {
                let toX, toY;
                if (d.isBoard) { toX = d.x; toY = d.y; }
                else if (d.type === 'board' && d.piece.owner !== GameState.turn) { toX = d.x; toY = d.y; }
                else return;

                if (ShogiLogic.isLegalMove(GameState.selected, toX, toY, GameState.turn, GameState.board)) {
                    // Promotion check
                    let needPromotion = false;
                    if (GameState.selected.type === 'board') {
                        const p = GameState.selected.piece;
                        if (!p.promoted && p.type === 'KAKU') {
                            const zone = (GameState.turn === SENTE && toY === 0) || (GameState.turn === GOTE && toY === 3);
                            const fromZone = (GameState.turn === SENTE && GameState.selected.y === 0) || (GameState.turn === GOTE && GameState.selected.y === 3);
                            if (zone || fromZone) needPromotion = true;
                        }
                    }
                    if (needPromotion) {
                        this.pendingMove = { sel: GameState.selected, tx: toX, ty: toY };
                        document.getElementById('promotion-overlay')!.style.display = 'flex';
                    } else {
                        this.commitMove(GameState.selected, toX, toY, false);
                    }
                }
            }
        } else { GameState.selected = null; ShogiView.render(GameState); }
    },

    isSameSelection(a, b) {
        if (a.type !== b.type) return false;
        if (a.type === 'board') return a.x === b.x && a.y === b.y;
        return a.index === b.index && a.owner === b.owner;
    },

    resolvePromotion(promote) {
        document.getElementById('promotion-overlay')!.style.display = 'none';
        if (this.pendingMove) {
            this.commitMove(this.pendingMove.sel, this.pendingMove.tx, this.pendingMove.ty, promote);
            this.pendingMove = null;
            this.initSounds();
        }

    },

    // UI Triggered Commit
    async commitMove(moveObj, tx, ty, promote) {
        // Construct Record
        let record;
        if (moveObj.type === 'board') {
            record = {
                type: 'board', fromX: moveObj.x, fromY: moveObj.y, toX: tx, toY: ty, piece: moveObj.piece.type, promote: promote
            };
        } else {
            record = {
                type: 'hand', toX: tx, toY: ty, piece: moveObj.pKey, promote: false
            };
        }
        
        this.commitMoveInternal(record, false);
    },

    commitMoveInternal(record, isLoading) {
        // Clear Redo
        if (!isLoading) {
             GameState.redoStack = [];
             GameState.redoMoves = [];
        }

        // Clone for history
        const prevBoard = JSON.parse(JSON.stringify(GameState.board));
        const prevHands = JSON.parse(JSON.stringify(GameState.hands));
        GameState.history.push({ board: prevBoard, hands: prevHands, turn: GameState.turn });
        GameState.moveRecords.push(record);

        // Apply
        const turn = GameState.turn;
        if (record.type === 'board') {
            GameState.board[record.fromY][record.fromX] = null;
            // Find piece object logic? No, just force set
            // Ideally we need the piece properties.
            // If internal, we use GameState. If loading, we use inferred.
            // But 'record' has only type string. We need to create object.
            
            // prevBoard から駒情報を取得し、新しいオブジェクトとしてコピー
            // （historyに保存されたprevBoardを変更しないため）
            const srcPiece = prevBoard[record.fromY][record.fromX];
            if (!record.piece) record.piece = srcPiece.type;
            const pObj = {
                type: srcPiece.type, 
                owner: srcPiece.owner, 
                promoted: record.promote ? true : srcPiece.promoted 
            };
            
            // Capture
            const target = GameState.board[record.toY][record.toX];
            if (target) {
                if (target.type === 'OU') {
                     if (!isLoading) this.handleGameOver(turn);
                }
                // 持ち駒に追加（UMAは成りを戻してKAKUとして）
                const capturedType = target.type === 'UMA' ? 'KAKU' : target.type;
                GameState.hands[turn].push(capturedType);
            }
            GameState.board[record.toY][record.toX] = pObj;
        } else {
            GameState.board[record.toY][record.toX] = { type: record.piece, owner: turn, promoted: false };
            // Remove from hand
            const hIdx = GameState.hands[turn].indexOf(record.piece);
            if (hIdx > -1) GameState.hands[turn].splice(hIdx, 1);
        }

        GameState.turn = (turn === SENTE) ? GOTE : SENTE;
        
        // Post-Move
        if (!isLoading) {
            this.checkGameStatus(turn);
            GameState.selected = null;
            ShogiView.render(GameState);
            this.updateURL();
            this.analyze(true);
            this.updateKifuList();
            this.updateReviewUI();
        }
    },

    undoMove() {
        if (GameState.history.length === 0) return;

        if (this.isGameOver) {
            this.clearGameOverState();
            this.isAiMode = this.aiModeBeforeGameOver;
        }
        
        // Clear any pending AI move
        if (this.autoPlayTimer) {
            clearTimeout(this.autoPlayTimer);
            this.autoPlayTimer = null;
        }

        this.undoMoveInternal();

        // In Game Mode (vs AI), if we undo to AI's turn, AI would immediately play back.
        // So we undo one more time to return to Player's turn.
        if (!GameState.reviewMode && this.isAiMode && GameState.turn !== this.playerSide) {
             if (GameState.history.length > 0) {
                 this.undoMoveInternal();
             }
        }
    },

    undoFromGameOver() {
        if (GameState.history.length === 0) return;
        this.clearGameOverState();
        this.isAiMode = this.aiModeBeforeGameOver;
        this.undoMove();
    },

    undoMoveInternal() {
        // Push to Redo
        const currentMove = GameState.moveRecords.pop();
        GameState.redoMoves.push(currentMove);
        GameState.redoStack.push({
            board: JSON.parse(JSON.stringify(GameState.board)),
            hands: JSON.parse(JSON.stringify(GameState.hands)),
            turn: GameState.turn
        });

        const prev = GameState.history.pop();
        this.evalHistory = this.evalHistory.filter(e => e.moveNodes <= GameState.history.length);
        GameState.board = prev.board;
        GameState.hands = prev.hands;
        GameState.turn = prev.turn;
        GameState.selected = null;
        
        ShogiView.render(GameState);
        this.updateURL();

        this.analyze(false); // Do not auto-play AI on undo
        this.updateReviewUI();
        this.updateKifuList();
    },
    
    redoMove() {
        if (GameState.redoStack.length === 0) return;
        
        const nextState = GameState.redoStack.pop();
        const moveRec = GameState.redoMoves.pop();
        
        // Push current to History
        GameState.history.push({
            board: JSON.parse(JSON.stringify(GameState.board)),
            hands: JSON.parse(JSON.stringify(GameState.hands)),
            turn: GameState.turn
        });
        GameState.moveRecords.push(moveRec);
        
        GameState.board = nextState.board;
        GameState.hands = nextState.hands;
        GameState.turn = nextState.turn;
        
        ShogiView.render(GameState);
        this.updateURL();

        this.analyze(false); // Do not auto-play AI on redo
        this.updateReviewUI();
        this.updateKifuList();
    },

    setUIState(state: 'open' | 'peek' | 'closed') {
        let normalizedState = state;
        if (normalizedState === 'peek' && !ShogiView.isMobile) {
            normalizedState = 'open';
        }

        this.uiState = normalizedState;
        const container = document.getElementById('ui-container');
        if (container) {
            container.setAttribute('data-ui-state', normalizedState);
        }
    },

    updateReviewUI() {
        const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement | null;
        const btnRedo = document.getElementById('btn-redo') as HTMLButtonElement | null;
        const peekUndo = document.getElementById('peek-undo') as HTMLButtonElement | null;
        const peekRedo = document.getElementById('peek-redo') as HTMLButtonElement | null;
        const gameOverUndo = document.getElementById('btn-gameover-undo') as HTMLButtonElement | null;
        const btnPrev = document.getElementById('btn-prev') as HTMLButtonElement | null;
        const btnNext = document.getElementById('btn-next') as HTMLButtonElement | null;
        const gameControls = document.getElementById('game-controls');
        const reviewControls = document.getElementById('review-controls');
        const reviewPos = document.getElementById('review-position');
        
        if (GameState.reviewMode) {
            // 振り返りモードUI
            if (gameControls) gameControls.style.display = 'none';
            if (reviewControls) reviewControls.style.display = 'block';
            
            this.setUIState('open');
            const current = GameState.history.length;
            const total = current + GameState.redoStack.length;
            if (reviewPos) reviewPos.textContent = `${current} / ${total} 手目`;
            
            if (btnPrev) btnPrev.disabled = GameState.history.length === 0;
            if (btnNext) btnNext.disabled = GameState.redoStack.length === 0;
            if (peekUndo) peekUndo.disabled = true;
            if (peekRedo) peekRedo.disabled = true;
            if (gameOverUndo) gameOverUndo.disabled = false;

            // 振り返り用評価値グラフ描画
            setTimeout(() => this.drawReviewEvalGraph(current), 50);
        } else {
            // 対局モードUI
            if (gameControls) gameControls.style.display = 'block';
            if (reviewControls) reviewControls.style.display = 'none';
            
            if (btnUndo) btnUndo.disabled = GameState.history.length === 0;
            if (btnRedo) btnRedo.disabled = GameState.redoStack.length === 0;
            if (peekUndo) peekUndo.disabled = GameState.history.length === 0;
            if (peekRedo) peekRedo.disabled = GameState.redoStack.length === 0;
            if (gameOverUndo) gameOverUndo.disabled = false;
        }

        this.renderEvaluationSummary();
    },
    
    exitReviewMode() {
        if (!GameState.reviewMode) return;
        
        // 最新局面に戻る
        while (GameState.redoStack.length > 0) {
            this.redoMove();
        }
        
        GameState.reviewMode = false;
        this.updateReviewUI();

        this.analyze(false); // Do not auto-play AI when returning from review
    },

    evalHistory: [] as { moveNodes: number; solveValue: SolveValue }[],

    resetGameFromUI() {
        window.location.href = './game.html';
    },

    openExplanationPage() {
        const encoded = KifuCodec.encode(GameState.moveRecords);
        const url = new URL('./explain.html', window.location.href);
        if (encoded) url.searchParams.set('m', encoded);
        window.location.href = url.toString();
    },

    // 棋譜リストをUIに反映
    updateKifuList() {
        const container = document.getElementById('kifu-list');
        if (!container) return;
        container.innerHTML = '';

        const totalMoves = GameState.moveRecords.length + GameState.redoMoves.length;
        const currentIndex = GameState.moveRecords.length;

        const createItem = (label: string, index: number, isCurrent: boolean, isFuture: boolean) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'kifu-item';
            if (isCurrent) btn.classList.add('is-current');
            if (isFuture) btn.classList.add('is-future');
            btn.textContent = label;
            btn.addEventListener('click', () => this.jumpToMove(index));
            return btn;
        };

        const startItem = createItem('開始局面', 0, currentIndex === 0, false);
        container.appendChild(startItem);

        const futureMoves = [...GameState.redoMoves].reverse();
        const allMoves = GameState.moveRecords.concat(futureMoves);

        allMoves.forEach((move, i) => {
            const moveNo = i + 1;
            const turnMark = moveNo % 2 === 1 ? '▲' : '△';
            const prevMove = i > 0 ? allMoves[i - 1] : null;
            const moveText = KifuCodec.moveToJapanese(move, prevMove);
            const label = `${moveNo}. ${turnMark}${moveText}`;
            const isCurrent = currentIndex === moveNo;
            const isFuture = moveNo > currentIndex;
            const item = createItem(label, moveNo, isCurrent, isFuture);
            container.appendChild(item);
        });

        const currentItem = container.querySelector('.is-current') as HTMLElement | null;
        if (currentItem) {
            currentItem.scrollIntoView({ block: 'nearest' });
        }
    },

    // 指定手数にジャンプ
    // 指定手数にジャンプ
    jumpToMove(targetIndex: number) {
        const totalMoves = GameState.moveRecords.length + GameState.redoMoves.length;
        const clampedTarget = Math.max(0, Math.min(targetIndex, totalMoves));
        if (this.autoPlayTimer) {
            clearTimeout(this.autoPlayTimer);
            this.autoPlayTimer = null;
        }

        while (GameState.moveRecords.length > clampedTarget) {
            this.undoMoveInternal();
        }
        while (GameState.moveRecords.length < clampedTarget) {
            this.redoMove();
        }
    },

    toggleUI() {
        const isMobile = ShogiView.isMobile;
        if (isMobile) {
            const cycle: Record<string, 'open' | 'peek' | 'closed'> = {
                open: 'peek',
                peek: 'closed',
                closed: 'open'
            };
            const nextState = cycle[this.uiState] || 'open';
            this.setUIState(nextState);
        } else {
            const nextState = this.uiState === 'open' ? 'closed' : 'open';
            this.setUIState(nextState);
        }
    },

    handleMobileLayoutChange(isMobile: boolean) {
        if (!isMobile && this.uiState === 'peek') {
            this.setUIState('open');
        }
    },
    
    // Review Navigation
    stepForward() {
        if (GameState.redoStack.length > 0) {
            this.redoMove();
        }
    },
    stepBackward() {
         if (GameState.history.length > 0) {
             this.undoMove();
         }
    },
    stepToBegin() {
        while(GameState.history.length > 0) this.undoMove();
    },
    stepToEnd() {
        while(GameState.redoStack.length > 0) this.redoMove();
    },



    // --- JSON Bucket Cache ---
    bucketCache: {},

    async fetchEvaluation(hashStr) {
        const bucket = hashStr.substring(0, 3).toLowerCase();

        // Load bucket if not cached
        if (!this.bucketCache[bucket]) {
            try {
                const res = await fetch(`data/lookup/${bucket}.json`);
                if (!res.ok) {
                    console.warn(`Bucket ${bucket}.json not found`);
                    this.bucketCache[bucket] = {};
                } else {
                    this.bucketCache[bucket] = await res.json();
                }
            } catch (e) {
                console.error(`Failed to load bucket ${bucket}:`, e);
                this.bucketCache[bucket] = {};
            }
        }

        return this.bucketCache[bucket][hashStr] || 'Unknown';
    },

    // Generate all legal next states from current GameState
    generateNextStates(state) {
        const nextStates: any[] = [];
        const turn = state.turn;

        // Board moves
        for (let y = 0; y < CONFIG.ROWS; y++) {
            for (let x = 0; x < CONFIG.COLS; x++) {
                const piece = state.board[y][x];
                if (!piece || piece.owner !== turn) continue;

                // Try all destination squares
                for (let ty = 0; ty < CONFIG.ROWS; ty++) {
                    for (let tx = 0; tx < CONFIG.COLS; tx++) {
                        const sel = { type: 'board', x, y, piece };
                        if (ShogiLogic.isLegalMove(sel, tx, ty, turn, state.board)) {
                            // Check if promotion is possible
                            const canPromote = !piece.promoted && piece.type === 'KAKU' &&
                                ((turn === SENTE && (ty === 0 || y === 0)) ||
                                    (turn === GOTE && (ty === 3 || y === 3)));

                            // Non-promotion move
                            nextStates.push({
                                state: this.applyMove(state, sel, tx, ty, false),
                                moveParams: { sel, tx, ty, promote: false }
                            });

                            // Promotion move if applicable
                            if (canPromote) {
                                nextStates.push({
                                    state: this.applyMove(state, sel, tx, ty, true),
                                    moveParams: { sel, tx, ty, promote: true }
                                });
                            }
                        }
                    }
                }
            }
        }

        // Hand drops
        const hand = state.hands[turn];
        const uniquePieces = [...new Set(hand)];
        for (const pKey of uniquePieces) {
            for (let y = 0; y < CONFIG.ROWS; y++) {
                for (let x = 0; x < CONFIG.COLS; x++) {
                    if (state.board[y][x]) continue;
                    const idx = hand.indexOf(pKey);
                    const sel = { type: 'hand', index: idx, pKey, owner: turn };
                    if (ShogiLogic.isLegalMove(sel, x, y, turn, state.board)) {
                        nextStates.push({
                            state: this.applyMove(state, sel, x, y, false),
                            moveParams: { sel, tx: x, ty: y, promote: false }
                        });
                    }
                }
            }
        }

        return nextStates;
    },

    // Apply a move to create a new state (without mutating original)
    applyMove(state, moveObj, tx, ty, promote) {
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

            // Capture
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
    },
    // Helper for coordinate conversion (Right-origin columns, 1-based rows)
    getShogiCoord(x, y) {
        const kanji = ['一', '二', '三', '四'];
        return `${4 - x}${kanji[y]}`;
    },

    // Detect move string from state transition
    detectMoveStr(current, next) {
        // Check for drop
        const pieces = { 'KIN': '金', 'KAKU': '角' };
        for (const [key, name] of Object.entries(pieces)) {
            const currCount = current.hands[current.turn].filter(k => k === key).length;
            const nextCount = next.hands[current.turn].filter(k => k === key).length;
            if (currCount > nextCount) {
                for (let y = 0; y < CONFIG.ROWS; y++) {
                    for (let x = 0; x < CONFIG.COLS; x++) {
                        if (!current.board[y][x] && next.board[y][x] && next.board[y][x].type === key) {
                            return `${this.getShogiCoord(x, y)}${name}打`;
                        }
                    }
                }
            }
        }

        // Board move
        let fromPos: any = null, toPos: any = null;
        for (let y = 0; y < CONFIG.ROWS; y++) {
            for (let x = 0; x < CONFIG.COLS; x++) {
                const c = current.board[y][x];
                const n = next.board[y][x];

                if (c && !n) { // Piece moved from here
                    fromPos = { x, y };
                } else if (!c && n) { // Piece moved to here
                    toPos = { x, y, piece: n };
                } else if (c && n && c.owner !== n.owner) { // Capture!
                    toPos = { x, y, piece: n };
                }
            }
        }

        if (fromPos && toPos) {
            const pieceNames = { 'OU': '王', 'KIN': '金', 'KAKU': '角', 'UMA': '馬' };
            const pieceName = pieceNames[current.board[fromPos.y][fromPos.x].type] || '?';
            const promoted = current.board[fromPos.y][fromPos.x]?.type === 'KAKU' &&
                toPos.piece.type === 'UMA' ? '成' : '';
            return `${this.getShogiCoord(toPos.x, toPos.y)}${pieceName}${promoted}(${this.getShogiCoord(fromPos.x, fromPos.y)})`;
        }

        return '不明';
    },

    // --- Analysis API (Cloudflare Workers D1) ---
    // --- Analysis API (Cloudflare Workers D1) ---
    async analyze(allowAutoPlay: boolean = true, retryCount: number = 0) {
        const expectedTurn = GameState.turn;
        try {
            // Call Cloudflare Workers API
            const response = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: GameState })
            });

            if (!response.ok) {
                // Try to get error details
                let errorMsg = `Status: ${response.status}`;
                try {
                    const errData = await response.text();
                    errorMsg += ` - ${errData}`;
                } catch (e) { /* ignore */ }

                console.warn(`Analysis API error: ${errorMsg}`);
                if (allowAutoPlay && retryCount < 1) {
                    setTimeout(() => {
                        if (GameState.turn === expectedTurn) this.analyze(allowAutoPlay, retryCount + 1);
                    }, 1500);
                }
                return;
            }

            const data = await response.json();

            // Create a map for quick lookup of server results by hash
            const serverResults = new Map(data.next_moves.map(m => [m.hash, m.result]));

            // Generate client-side moves
            const generated = this.generateNextStates(GameState);

            // Build final move list based on CLIENT generation
            const mergedMoves = generated.map((gen, i) => {
                try {
                    const hash = HashCalc.hashToString(HashCalc.calcHash(gen.state));
                    const result = serverResults.get(hash) || 'Unknown';

                    return {
                        move_str: this.detectMoveStr(GameState, gen.state),
                        state: gen.state,
                        moveParams: gen.moveParams,
                        result: result,
                        hash: hash,
                        index: i
                    };
                } catch (e) {
                    console.error("[Analyze] Error processing move " + i, e);
                    return { index: i, move_str: "Error", result: 'Unknown' };
                }
            });

            data.next_moves = mergedMoves;

            // Handle Logic (AI Move, Game Over check)
            this.handleAnalysisResult(data, allowAutoPlay);
        } catch (e: any) {
            console.error('Analysis error:', e);
            if (allowAutoPlay && retryCount < 1) {
                setTimeout(() => {
                    if (GameState.turn === expectedTurn) this.analyze(allowAutoPlay, retryCount + 1);
                }, 1500);
            }
        }
    },



    // --- AI Turn Logic ---
    isAiMode: true,
    aiModeBeforeGameOver: true,
    playerSide: SENTE, // Human is Sente by default

    // toggleAiMode removed

    // --- Sound & Game End Logic ---
    sounds: {},
    isSoundMuted: localStorage.getItem('tinyShogiSoundMuted') === 'true',
    isGameOver: false,
    clearGameOverState() {
        this.isGameOver = false;
        this.isAiMode = this.aiModeBeforeGameOver;
        this.gameOverGraphHoverIndex = null;
        const overlay = document.getElementById('game-over-overlay');
        if (overlay) overlay.style.display = 'none';
        const readout = document.getElementById('eval-graph-readout');
        if (readout) readout.textContent = '';
    },
    initSounds() {

        this.sounds.oute = new Audio(assetUrl('oute.mp3'));
        this.sounds.sokomade = new Audio(assetUrl('sokomade.mp3'));
        this.sounds.yorosiku = new Audio(assetUrl('yorosiku.mp3'));
    },
    playSound(key) {
        if (this.isSoundMuted) return;
        if (this.sounds[key]) {
            this.sounds[key].currentTime = 0;
            this.sounds[key].play().catch(e => console.log(e));
        }
    },
    toggleSoundMute() {
        this.isSoundMuted = !this.isSoundMuted;
        localStorage.setItem('tinyShogiSoundMuted', String(this.isSoundMuted));
        this.updateSoundBtn();
    },
    updateSoundBtn() {
        const btn = document.getElementById('btn-sound-toggle');
        if (!btn) return;
        const iconOn = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
        const iconOff = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
        btn.innerHTML = this.isSoundMuted ? `${iconOff}音声OFF` : `${iconOn}音声ON`;
    },

    checkGameStatus(lastMovePlayer) {
        // Check for Oute (Check) on the opponent of lastMovePlayer
        const opponent = lastMovePlayer === SENTE ? GOTE : SENTE;
        const isCheck = ShogiLogic.isKingInCheck(GameState.board, opponent);

        if (this.isGameOver) return; // Already handled

        // 千日手検出: 同一局面が4回出現したら先手負け
        const currentHash = HashCalc.encodeHash(GameState);
        let repetitionCount = 1;
        for (const histState of GameState.history) {
            if (HashCalc.encodeHash(histState) === currentHash) {
                repetitionCount++;
            }
        }
        if (repetitionCount >= 4) {
            this.handleGameOver(GOTE, 'sennichite');
            return;
        }

        if (isCheck) {
            this.playSound('oute');
        } else if (!this.isSoundMuted) {
            const soundIndex = Math.floor(Math.random() * 3) + 1;
            const snd = new Audio(assetUrl(`Shogi${soundIndex}.mp3`));
            snd.play().catch(() => { });
        }
    },

    handleGameOver(winner: any, reason?: string) {
        if (this.isGameOver) return;
        this.aiModeBeforeGameOver = this.isAiMode;
        this.isGameOver = true;
        this.playSound('sokomade');

        const title = document.getElementById('game-over-title')!;
        const content = document.getElementById('game-over-content')!;
        const moves = GameState.history.length;

        if (reason === 'sennichite') {
            title.textContent = "千日手";
            title.style.color = "#1565C0";
            content.innerHTML = `
                <div style="font-size:1.5rem; font-weight:bold; color:#1565C0; margin: 10px 0;">
                    千日手により先手負け
                </div>
                <div style="font-size:1.1rem; color:#6D4C41; margin-top: 8px;">
                    ${moves}手目
                </div>
            `;
        } else {
        // Human is SENTE (Main.playerSide)
        const isHumanWinner = (winner === this.playerSide);

        if (isHumanWinner) {
            title.textContent = "勝利！";
            title.style.color = "#d32f2f";

            if (moves === 27) {
                content.innerHTML = `
                    <div style="font-size:1.8rem; font-weight:bold; color:#d32f2f; margin: 10px 0;">
                        完璧です！<br>最短27手での勝利！<br>すべて最善手でした！
                    </div>
                `;
            } else {
                content.innerHTML = `
                    <div style="font-size:1.8rem; font-weight:bold; color:#d32f2f; margin: 10px 0;">
                        ${moves}手で勝利！
                    </div>
                    <div style="font-size:1.1rem; color:#6D4C41; margin-top: 8px;">
                        (最短は27手です)
                    </div>
                `;
            }
        } else {
            title.textContent = "敗北...";
            title.style.color = "#4E342E";

            let badMoveIndex = -1;
            const evalData = this.getEvalGraphData();
            for (let i = 1; i < evalData.length; i++) {
                const prevRate = evalData[i - 1].senteWinRate;
                const currRate = evalData[i].senteWinRate;
                if (prevRate !== null && currRate !== null && prevRate > 50 && currRate <= 5) {
                    badMoveIndex = evalData[i].moveNodes;
                    break;
                }
            }

            const withBadMove = [
                `${badMoveIndex}手目が敗着でした。`,
                `${badMoveIndex}手目の選択が明暗を分けました。`,
                `${badMoveIndex}手目で形勢が逆転しました。`,
                `${badMoveIndex}手目を振り返ってみましょう。`,
                `惜しい！${badMoveIndex}手目がターニングポイントでした。`,
            ];
            const withoutBadMove = [
                `一手一手が大切です。もう一度！`,
                `次こそは勝てる！`,
                `難しい局面が続きましたね。`,
            ];

            const message = badMoveIndex > 0
                ? withBadMove[Math.floor(Math.random() * withBadMove.length)]
                : withoutBadMove[Math.floor(Math.random() * withoutBadMove.length)];

            content.innerHTML = `
                <div style="font-size:1.3rem; margin: 10px 0;">
                    ${message}
                </div>
                <div style="font-size:1.1rem; color:#6D4C41; margin-top: 8px;">
                    (最短は27手です)
                </div>
            `;

        }
        } // end else (not sennichite)

        const gameOverStats = document.getElementById('game-over-stats');
        if (gameOverStats) {
            gameOverStats.style.display = 'flex';
            this.gameOverGraphHoverIndex = null;
            setTimeout(() => this.drawEvalGraph(), 50);
        }

        document.getElementById('game-over-overlay')!.style.display = 'flex';
        
        // Stop AI logic
        this.isAiMode = false;
        this.updateReviewUI();
    },



    handleAnalysisResult(data, allowAutoPlay: boolean) {
        // Validation: Ensure the analysis data matches current game state turn
        const analysisTurn = data.turn === "Sente" ? SENTE : GOTE;
        if (analysisTurn !== GameState.turn) {
            console.log("Analysis result stale (turn mismatch), ignoring.");
            return;
        }

        this.currentAnalysisData = data;

        const currentTurn = data.turn === "Sente" ? SENTE : GOTE;
        const solveValue = parseRawSolve(data.current_evaluation, currentTurn);
        const evalDisplay = buildEvalDisplay(solveValue, this.winRateMapper);
        this.currentEvalDisplay = evalDisplay;
        this.renderEvaluationSummary(evalDisplay);

        // Record Evaluation (display-only history)
        this.recordEvaluation(solveValue);

        // Check if Current Player has Lost immediately (Checkmate or empty moves)
        // If 'Lose' is 0, it means we are mated.
        if (this.isImmediateLose(data.current_evaluation)) {
            // Record the mate state
            // Current turn player lost. Opponent won.
            const winner = (data.turn === 'Sente') ? GOTE : SENTE;
            this.handleGameOver(winner);
            return;
        }

        // Sort moves for "Perfect Play"
        // Move selection logic remains the same
        const moves = data.next_moves.map(m => {
            let score = 0;
            if (m.result.Lose !== undefined) {
                // Opponent Lose(N) -> We Win in N. 
                // Smaller N is better.
                score = 100000 - m.result.Lose;
            } else if (m.result.Win !== undefined) {
                // Opponent Win(N) -> We Lose in N.
                // Larger N is better (delay defeat).
                score = -100000 + m.result.Win;
            } else {
                score = 0;
            }
            return { ...m, score };
        });

        // Sort descending (Higher score is better for current player)
        moves.sort((a, b) => b.score - a.score);
        
        // Store sorted moves back to data for AI use
        // (Actually data.next_moves was modified in place but let's be safe if we need to access it)
        
        // Look for Game Over by insufficient moves?
        // Usually handled by Lose=0 check above.

        // Auto Play Trigger for AI
        // Always active if it is AI's turn AND auto-play is allowed
        if (allowAutoPlay && this.isAiMode && currentTurn !== this.playerSide) {
            if (moves.length > 0) {
                const bestMove = moves[0];
                
                this.autoPlayTimer = setTimeout(() => {
                    this.commitMoveFromUI(bestMove.index);
                }, 500); // 500ms delay for visual pacing
            } else {
                // No moves available? Treat as Loss.
                const winner = (currentTurn === SENTE) ? GOTE : SENTE;
                this.handleGameOver(winner);
            }
        }
    },

    commitMoveFromUI(idx) {
        // 既存のAI自動応手タイマーをクリア
        if (this.autoPlayTimer) {
            clearTimeout(this.autoPlayTimer);
            this.autoPlayTimer = null;
        }
        if (!this.currentAnalysisData || !this.currentAnalysisData.next_moves) {
            return;
        }
        if (this.isGameOver) {
            return;
        }

        const moveData = this.currentAnalysisData.next_moves.find(m => m.index === idx);
        if (!moveData) {
            return;
        }

        // Use robust moveParams instead of parsing strings
        if (moveData.moveParams) {
            const { sel, tx, ty, promote } = moveData.moveParams;
            this.commitMove(sel, tx, ty, promote);
        } else {
            console.error("Missing moveParams for index " + idx);
        }
    },

    calculateScore(res) {
        // Logic from score_for_gote (but generic)
        // Goal: Make Opponent Loos as fast as possible.
        // Lose(n) -> Opponent loses in n. Smaller n is best.
        // Unknown -> Middle
        // Win(n) -> Opponent wins in n. Larger n is better (delay loss).

        if (res.Lose !== undefined) return res.Lose; // 0..infinity
        if (res === 'Unknown') return 90000;
        if (res.Win !== undefined) return 100000 + (1000 - res.Win); // Larger Win(n) -> Smaller score? No.
        // Win(1) -> Opponent wins in 1. Bad. Score should be High.
        // Win(100) -> Opponent wins in 100. Better. Score should be Lower than Win(1).
        // So: 100000 + (Max - n)
        return 200000;
    },

    isImmediateLose(rawEval: any) {
        return typeof rawEval === 'object' &&
            rawEval !== null &&
            typeof rawEval.Lose === 'number' &&
            rawEval.Lose === 0;
    },

    renderEvaluationSummary(display?: EvalDisplay) {
        const current = display || this.currentEvalDisplay || buildEvalDisplay({ kind: 'unknown' }, this.winRateMapper);
        const mainText = `評価: ${current.headlineLabel}`;
        const subText = `（${current.solveLabel}）`;

        const liveMain = document.getElementById('eval-summary-live-main');
        const liveSub = document.getElementById('eval-summary-live-sub');
        const reviewMain = document.getElementById('eval-summary-review-main');
        const reviewSub = document.getElementById('eval-summary-review-sub');

        if (liveMain) liveMain.textContent = mainText;
        if (liveSub) liveSub.textContent = subText;
        if (reviewMain) reviewMain.textContent = mainText;
        if (reviewSub) reviewSub.textContent = subText;
    },

    // --- Graph & Evaluation Helpers ---
    recordEvaluation(solveValue: SolveValue) {
        this.evalHistory.push({
            moveNodes: GameState.history.length,
            solveValue
        });
    },

    getEvalGraphData() {
        return [
            { moveNodes: 0, senteWinRate: 50, solveLabel: '開始局面' },
            ...this.evalHistory.map(item => {
                const display = buildEvalDisplay(item.solveValue, this.winRateMapper);
                return {
                    moveNodes: item.moveNodes,
                    senteWinRate: display.senteWinRate,
                    solveLabel: display.solveLabel
                };
            })
        ];
    },

    updateGameOverGraphReadout(data, index?: number) {
        const readout = document.getElementById('eval-graph-readout');
        if (!readout || data.length === 0) return;

        let targetIndex = index;
        if (targetIndex === undefined || targetIndex === null || targetIndex < 0 || targetIndex >= data.length) {
            targetIndex = data.length - 1;
        }

        const pt = data[targetIndex];
        const prefix = pt.moveNodes === 0 ? '開始局面' : `${pt.moveNodes}手目`;
        const valueText = pt.senteWinRate === null ? '先手 N/A' : `先手 ${Math.round(pt.senteWinRate)}%`;
        const solveText = pt.solveLabel ? `（${pt.solveLabel}）` : '';
        readout.textContent = `${prefix}: ${valueText}${solveText}`;
    },

    drawEvalGraph(highlightIndex?: number) {
        const canvas = document.getElementById('eval-graph') as HTMLCanvasElement;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Resize canvas for high DPI
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        
        const w = rect.width;
        const h = rect.height;

        ctx.clearRect(0, 0, w, h);
        
        // Data: 初期局面(0手目)から始まる
        const data = this.getEvalGraphData();
        const margins = { left: 44, right: 10, top: 12, bottom: 24 };
        const plotW = Math.max(1, w - margins.left - margins.right);
        const plotH = Math.max(1, h - margins.top - margins.bottom);
        
        if (data.length < 2) {
            this.updateGameOverGraphReadout(data);
            return;
        }

        // Scales
        const maxMoves = data.length;
        
        const mapX = (i: number) => margins.left + (i / Math.max(maxMoves - 1, 1)) * plotW;
        const mapY = (p: number) => margins.top + (1 - Math.max(0, Math.min(100, p)) / 100) * plotH;

        // X座標から手数インデックスを逆算
        const mapXToIndex = (px: number) => {
            const ratio = (px - margins.left) / plotW;
            const clamped = Math.max(0, Math.min(1, ratio));
            return Math.round(clamped * (maxMoves - 1));
        };

        // Axes
        ctx.beginPath();
        ctx.strokeStyle = '#BCAAA4';
        ctx.lineWidth = 1;
        ctx.moveTo(margins.left, margins.top);
        ctx.lineTo(margins.left, margins.top + plotH);
        ctx.lineTo(margins.left + plotW, margins.top + plotH);
        ctx.stroke();

        // Draw 50% Line
        ctx.beginPath();
        ctx.strokeStyle = '#D7CCC8';
        ctx.lineWidth = 1;
        ctx.moveTo(margins.left, mapY(50));
        ctx.lineTo(margins.left + plotW, mapY(50));
        ctx.stroke();

        // Axis ticks and labels
        const yTicks = [100, 50, 0];
        ctx.fillStyle = '#6D4C41';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        yTicks.forEach(tick => {
            const y = mapY(tick);
            ctx.beginPath();
            ctx.strokeStyle = '#BCAAA4';
            ctx.moveTo(margins.left - 4, y);
            ctx.lineTo(margins.left, y);
            ctx.stroke();
            ctx.fillText(`${tick}%`, margins.left - 6, y);
        });

        const xTicks = [0, Math.floor((maxMoves - 1) / 2), maxMoves - 1];
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        xTicks.forEach((tick, idx) => {
            if (idx === 1 && xTicks[0] === xTicks[2]) return;
            const x = mapX(tick);
            ctx.beginPath();
            ctx.strokeStyle = '#BCAAA4';
            ctx.moveTo(x, margins.top + plotH);
            ctx.lineTo(x, margins.top + plotH + 4);
            ctx.stroke();
            ctx.fillText(`${tick}`, x, margins.top + plotH + 6);
        });

        // Axis titles
        ctx.save();
        ctx.translate(12, margins.top + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('先手勝率', 0, 0);
        ctx.restore();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('手数', margins.left + plotW / 2, h - 2);

        // Draw Graph (null は線を分断)
        ctx.strokeStyle = '#6D4C41';
        ctx.lineWidth = 2;
        ctx.beginPath();
        let drawing = false;
        data.forEach((p, i) => {
            if (p.senteWinRate === null) {
                drawing = false;
                return;
            }
            const x = mapX(i);
            const y = mapY(p.senteWinRate);
            if (!drawing) {
                ctx.moveTo(x, y);
                drawing = true;
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.stroke();

        // Draw End Point
        const last = [...data].reverse().find(p => p.senteWinRate !== null);
        if (last && last.senteWinRate !== null) {
            const lastIndex = data.lastIndexOf(last);
            ctx.beginPath();
            ctx.fillStyle = last.senteWinRate > 50 ? '#d32f2f' : (last.senteWinRate < 50 ? '#1976D2' : '#6D4C41');
            ctx.arc(mapX(lastIndex), mapY(last.senteWinRate), 4, 0, Math.PI * 2);
            ctx.fill();
        }

        // 現在位置マーカー表示
        if (highlightIndex !== undefined && highlightIndex >= 0 && highlightIndex < data.length) {
            const pt = data[highlightIndex];
            if (pt.senteWinRate !== null) {
                ctx.beginPath();
                ctx.fillStyle = '#FFD700';
                ctx.strokeStyle = '#4E342E';
                ctx.lineWidth = 2;
                ctx.arc(mapX(highlightIndex), mapY(pt.senteWinRate), 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }

        const activeIndex = (highlightIndex !== undefined) ? highlightIndex : this.gameOverGraphHoverIndex;
        this.updateGameOverGraphReadout(data, activeIndex ?? undefined);

        canvas.onpointerdown = (e) => {
            const canvasRect = canvas.getBoundingClientRect();
            const x = e.clientX - canvasRect.left;
            const y = e.clientY - canvasRect.top;
            if (x < margins.left || x > margins.left + plotW || y < margins.top || y > margins.top + plotH) return;
            this.gameOverGraphHoverIndex = mapXToIndex(x);
            this.drawEvalGraph(this.gameOverGraphHoverIndex);
        };
        canvas.onpointermove = (e) => {
            const canvasRect = canvas.getBoundingClientRect();
            const x = e.clientX - canvasRect.left;
            const y = e.clientY - canvasRect.top;
            if (x < margins.left || x > margins.left + plotW || y < margins.top || y > margins.top + plotH) return;
            this.gameOverGraphHoverIndex = mapXToIndex(x);
            this.drawEvalGraph(this.gameOverGraphHoverIndex);
        };
        canvas.onpointerleave = () => {
            this.gameOverGraphHoverIndex = null;
            this.drawEvalGraph();
        };
    },

    // グラフクリックから指定手数にジャンプ（振り返り用）
    // グラフクリックから指定手数にジャンプ（振り返り用）
    jumpToMoveFromGraph(targetMoveNodes: number) {
       // Functionality removed
    },

    // 振り返りモード用の評価値グラフ描画
    drawReviewEvalGraph(highlightMoveIndex: number) {
        const canvas = document.getElementById('review-eval-graph') as HTMLCanvasElement;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Resize canvas for high DPI
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        
        const w = rect.width;
        const h = rect.height;

        ctx.clearRect(0, 0, w, h);
        
        // Data: 初期局面(0手目)から始まる
        const data = this.getEvalGraphData();
        
        if (data.length < 2) {
            // グラフ描画不可時はメッセージ表示
            ctx.font = '12px sans-serif';
            ctx.fillStyle = '#888';
            ctx.textAlign = 'center';
            ctx.fillText('勝率データなし', w / 2, h / 2);
            return;
        }

        // 総手数（undo + redo含む）
        const totalMoves = GameState.history.length + GameState.redoStack.length;
        const maxMoves = Math.max(data.length, totalMoves + 1);
        
        const mapX = (i: number) => (i / Math.max(maxMoves - 1, 1)) * w;
        const mapY = (p: number) => h - (Math.max(0, Math.min(100, p)) / 100) * h;

        // X座標から手数インデックスを逆算
        const mapXToIndex = (px: number) => Math.round((px / w) * Math.max(maxMoves - 1, 1));

        // Draw 50% Line
        ctx.beginPath();
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        ctx.moveTo(0, mapY(50));
        ctx.lineTo(w, mapY(50));
        ctx.stroke();

        // Draw Graph (null は線を分断)
        ctx.beginPath();
        ctx.strokeStyle = '#6D4C41';
        ctx.lineWidth = 2;
        let drawing = false;
        data.forEach((p, i) => {
            if (p.senteWinRate === null) {
                drawing = false;
                return;
            }
            const x = mapX(i);
            const y = mapY(p.senteWinRate);
            if (!drawing) {
                ctx.moveTo(x, y);
                drawing = true;
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.stroke();

        // 現在位置マーカー
        // highlightMoveIndexは手数（0〜N）
        // dataはmoveNodes: 0, 1, 2, ...なので対応するインデックスを探す
        let highlightDataIndex = -1;
        for (let i = 0; i < data.length; i++) {
            if (data[i].moveNodes === highlightMoveIndex) {
                highlightDataIndex = i;
                break;
            }
        }
        // 見つからない場合、最も近いものを使う
        if (highlightDataIndex === -1) {
            highlightDataIndex = Math.min(highlightMoveIndex, data.length - 1);
        }

        if (highlightDataIndex >= 0 && highlightDataIndex < data.length) {
            const pt = data[highlightDataIndex];
            if (pt.senteWinRate !== null) {
                ctx.beginPath();
                ctx.fillStyle = '#FFD700';
                ctx.strokeStyle = '#4E342E';
                ctx.lineWidth = 2;
                ctx.arc(mapX(highlightDataIndex), mapY(pt.senteWinRate), 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }

        // クリックイベント設定
        const newCanvas = canvas.cloneNode(true) as HTMLCanvasElement;
        canvas.parentNode?.replaceChild(newCanvas, canvas);
        
        newCanvas.addEventListener('click', (e) => {
            const canvasRect = newCanvas.getBoundingClientRect();
            const clickX = e.clientX - canvasRect.left;
            const index = mapXToIndex(clickX);
            
            // クリック位置の手数にジャンプ
            if (index >= 0 && index < data.length) {
                const targetMoveNodes = data[index].moveNodes;
                this.jumpToMoveFromGraph(targetMoveNodes);
            }
        });

        newCanvas.style.cursor = 'pointer';
    },

    async shareResult() {
        const shareBtn = document.getElementById('btn-gameover-share') as HTMLButtonElement | null;
        const originalButtonHtml = shareBtn ? shareBtn.innerHTML : "Post to X";
        const restoreShareBtn = () => {
            if (!shareBtn) return;
            shareBtn.disabled = false;
            shareBtn.innerHTML = originalButtonHtml;
        };
        if (shareBtn) { shareBtn.disabled = true; shareBtn.textContent = "作成中..."; }

        try {
            // Capture body (Board + Overlay)
            const canvas = await html2canvas(document.body, {
                useCORS: true,
                backgroundColor: '#000000', // Ensure background is black if transparent
                ignoreElements: (el) => el.id === 'ui-container' || el.classList.contains('victory-actions'),
                scale: Math.min(2, window.devicePixelRatio) 
            });

            // Blob
            canvas.toBlob(async (blob) => {
                if (!blob) {
                    restoreShareBtn();
                    return;
                }
                const file = new File([blob], "tiny-shogi-result.png", { type: "image/png" });
                
                const moves = GameState.history.length;
                let outcome = "対局終了";
                const titleEl = document.getElementById('game-over-title');
                if (titleEl) {
                    if (titleEl.textContent?.includes('勝利')) outcome = "勝利！";
                    else if (titleEl.textContent?.includes('敗北')) outcome = "敗北...";
                }

                const text = `Tiny将棋 - Perfect AIに${moves}手で${outcome} #TinyShogi`;

                if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                    try {
                        await navigator.share({
                            title: 'Tiny将棋 Result',
                            text: text,
                            files: [file]
                        });
                    } catch (e) { console.log("Share failed/cancelled", e); }
                } else {
                    // Fallback: Download and Open Twitter
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = "tiny-shogi-result.png";
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    
                    const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(window.location.href)}`;
                    window.open(tweetUrl, '_blank');
                    
                    alert("画像を保存しました\nX(Twitter)に添付してシェアしてください！");
                }
                
                restoreShareBtn();
            }, 'image/png');

        } catch (e) {
            console.error(e);
            alert("Share failed: " + e);
            restoreShareBtn();
        }
    },

    convertStateToRust(gs) {
        // board: 4x4 i8. 0=Empty. + for Sente, - for Gote.
        // 1=King, 2=Gold, 3=Bishop, 4=Horse
        const board = Array.from({ length: 4 }, () => Array(4).fill(0));
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const p = gs.board[y][x];
                if (p) {
                    let val = 0;
                    if (p.type === 'OU') val = 1;
                    else if (p.type === 'KIN') val = 2;
                    else if (p.type === 'KAKU') val = 3;

                    if (p.promoted) val = 4; // Horse

                    if (p.owner === GOTE) val = -val;
                    board[y][x] = val;
                }
            }
        }

        const countHand = (owner, type) => gs.hands[owner].filter(k => k === type).length;
        const sente = [countHand(SENTE, 'KIN'), countHand(SENTE, 'KAKU')];
        const gote = [countHand(GOTE, 'KIN'), countHand(GOTE, 'KAKU')];

        return {
            is_sente: gs.turn === SENTE,
            board: board,
            sente: sente,
            gote: gote
        };
    },

    sprintPositionsCache: null as null | any[],

    async startSprint() {
        if (this.autoPlayTimer) {
            clearTimeout(this.autoPlayTimer);
            this.autoPlayTimer = null;
        }
        if (!this.sprintPositionsCache) {
            try {
                const res = await fetch('/sprint_positions.json');
                this.sprintPositionsCache = await res.json();
            } catch (e) {
                console.error('スプリント局面の読み込みに失敗しました', e);
                return;
            }
        }
        const positions = this.sprintPositionsCache!;
        const pos = positions[Math.floor(Math.random() * positions.length)];

        GameState.reset();

        const pieceMap: Record<number, { type: string; promoted: boolean } | null> = {
            0: null,
            1: { type: 'OU',   promoted: false },
            2: { type: 'KIN',  promoted: false },
            3: { type: 'KAKU', promoted: false },
            4: { type: 'KAKU', promoted: true  },
        };

        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const val: number = pos.board[y][x];
                const absVal = Math.abs(val);
                const info = pieceMap[absVal];
                GameState.board[y][x] = info
                    ? { type: info.type, owner: val > 0 ? SENTE : GOTE, promoted: info.promoted }
                    : null;
            }
        }

        for (let i = 0; i < pos.sente_kin;  i++) GameState.hands[SENTE].push('KIN');
        for (let i = 0; i < pos.sente_kaku; i++) GameState.hands[SENTE].push('KAKU');
        for (let i = 0; i < pos.gote_kin;   i++) GameState.hands[GOTE].push('KIN');
        for (let i = 0; i < pos.gote_kaku;  i++) GameState.hands[GOTE].push('KAKU');

        GameState.turn = SENTE;
        this.isAiMode = true;
        this.playerSide = SENTE;
        this.isGameOver = false;
        this.evalHistory = [];
        this.currentEvalDisplay = buildEvalDisplay({ kind: 'unknown' }, this.winRateMapper);

        const overlay = document.getElementById('game-over-overlay');
        if (overlay) overlay.style.display = 'none';

        ShogiView.render(GameState);
        this.renderEvaluationSummary();
        this.updateReviewUI();
        this.updateKifuList();
        this.analyze();
    }
};

(window as any).Main = Main;
Main.init();
if ((window as any).__sprintMode) {
    Main.startSprint();
}
