import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { Tween, Easing, Group } from '@tweenjs/tween.js';

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
const PIECE_TYPES = {
    OU: { name: '王', moves: [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]] },
    KIN: { name: '金', moves: [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1]] },
    KAKU: { name: '角', moves: [[1, 1], [1, -1], [-1, 1], [-1, -1]], range: true },
    UMA: { name: '馬', moves: [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0]], range: true, slidingPart: [[1, 1], [1, -1], [-1, 1], [-1, -1]] },
    GIN: { name: '銀', moves: [[-1, 1], [0, 1], [1, 1], [-1, -1], [1, -1]] }, 
    HISHA: { name: '飛', moves: [[1, 0], [-1, 0], [0, 1], [0, -1]], range: true },
    FU: { name: '歩', moves: [[0, 1]] },
    TO: { name: 'と', moves: [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1]] }
};

// --- Logic for Play Mode ---
const ShogiLogic = {
    isPseudoLegalMove(sel, tx, ty, currentBoard) {
        if (sel.type === 'board') {
            const p = sel.piece;
            if (currentBoard[ty][tx]?.owner === p.owner) return false;
            let def = PIECE_TYPES[p.type];
            
            if (p.promoted) {
                 if (p.type === 'KAKU') def = PIECE_TYPES.UMA;
                 else if (p.type === 'HISHA') def = PIECE_TYPES.HISHA; // Fallback for Dragon
                 else def = PIECE_TYPES.KIN;
            }
            if (!def) def = PIECE_TYPES.KIN; 

            const dx = tx - sel.x, dy = ty - sel.y;

            if (def.range) {
                const ax = Math.abs(dx), ay = Math.abs(dy);
                const signX = Math.sign(dx), signY = Math.sign(dy);
                let isSliding = false;
                if (def.slidingPart) { // UMA
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
                    if (p.type === 'HISHA') isSliding = (dx === 0 && dy !== 0) || (dy === 0 && dx !== 0);
                    else if (p.type === 'KAKU') isSliding = (ax === ay && ax > 0);
                }

                if (isSliding) {
                    let cx = sel.x + signX, cy = sel.y + signY;
                    while (cx !== tx || cy !== ty) {
                        if (currentBoard[cy][cx] !== null) return false;
                        cx += signX; cy += signY;
                    }
                    return true;
                }
                
                return def.moves ? def.moves.some(m => {
                    const mx = p.owner === SENTE ? m[0] : -m[0];
                    const my = p.owner === SENTE ? m[1] : -m[1];
                    return dx === mx && dy === my;
                }) : false;
            } else {
                // Step only
                 return def.moves.some(m => {
                    const mx = p.owner === SENTE ? m[0] : -m[0];
                    const my = p.owner === SENTE ? m[1] : -m[1];
                    return dx === mx && dy === my;
                });
            }
        }
        return false;
    }
};

// --- State ---
const EditorState: any = {
    board: [],
    hands: { sente: [], gote: [] },
    selected: null, 
    mode: 'EDIT', // 'EDIT' or 'PLAY'
    reset() {
        this.board = Array.from({ length: CONFIG.ROWS }, () => Array(CONFIG.COLS).fill(null));
        this.hands = { sente: [], gote: [] };
        this.selected = null;
    }
};

// --- View ---
const EditorView = {
    scene: null as any, camera: null as any, renderer: null as any, cssRenderer: null as any,
    raycaster: null as any, mouse: null as any,
    meshes: { board: [], pieces: [], palette: [], hands: [], komadai: { sente: null, gote: null } } as any,
    isMobile: false,

    init() {
        this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x000000);
        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(0, 22, 2); 
        this.camera.lookAt(0, -1, 0);

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

        this.updateLayout();
        this.animate();
    },

    updateLayout() {
        const w = 4.0; const d = 6.0; const scaleZ = CONFIG.BOARD_WIDTH / d;
        if (this.meshes.komadai.sente && this.meshes.komadai.gote) {
             this.meshes.komadai.sente.scale.set(1, 1, scaleZ);
             this.meshes.komadai.gote.scale.set(1, 1, scaleZ);
             const zOffset = CONFIG.BOARD_HEIGHT / 2 + 2.0 + 0.5;
             this.meshes.komadai.sente.position.set(0, -CONFIG.BOARD_THICKNESS + CONFIG.TABLE_HEIGHT / 2, zOffset);
             this.meshes.komadai.sente.rotation.y = Math.PI / 2;
             this.meshes.komadai.gote.position.set(0, -CONFIG.BOARD_THICKNESS + CONFIG.TABLE_HEIGHT / 2, -zOffset);
             this.meshes.komadai.gote.rotation.y = Math.PI / 2;
        }
        EditorView.render(EditorState);
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
        this.meshes.palette.forEach(g => { this.scene.remove(g); this.cleanupObj(g); }); this.meshes.palette = [];
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
        
        if (state.mode === 'EDIT') {
            this.drawPalette(state);
        }
        this.drawHands(state);
        
        if (state.mode === 'PLAY' && state.selected && state.selected.type === 'board') {
            this.highlightLegalMoves(state);
        }
    },
    
    highlightLegalMoves(state) {
        for (let y = 0; y < CONFIG.ROWS; y++) for (let x = 0; x < CONFIG.COLS; x++) {
            if (ShogiLogic.isPseudoLegalMove(state.selected, x, y, state.board)) {
                const mesh = this.meshes.board.find(m => m.userData.x === x && m.userData.y === y);
                if (mesh) mesh.material.opacity = 0.5;
            }
        }
    },

    drawPalette(state) {
        // Draw separate palette for Sente and Gote to the side
        const boxItems = ['OU', 'KIN', 'KAKU', 'GIN', 'HISHA', 'FU'];
        
        // Sente Palette (Right side)
        const sX = 6.0; 
        const sZ = 3.75; 
        boxItems.forEach((k, i) => {
            const g = this.createPieceObject({ type: k, owner: SENTE, promoted: false });
            // Vertical list
            g.position.set(sX, 0, sZ - i * 1.5);
            g.userData = { type: 'palette', pKey: k, owner: SENTE };
            
            if (state.selected && state.selected.type === 'palette' && state.selected.owner === SENTE && state.selected.pKey === k) {
                g.position.y += 0.3; ((g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0x664422);
            }
            this.scene.add(g); this.meshes.palette.push(g);
        });

        // Gote Palette (Left side)
        const gX = -6.0;
        const gZ = -3.75;
        boxItems.forEach((k, i) => {
            const g = this.createPieceObject({ type: k, owner: GOTE, promoted: false });
            // Vertical list, maybe reversed or same direction?
            // Let's go from Top (-Z) down to Bottom (+Z) conceptually?
            // Or just mirror Sente's layout?
            // Sente: 3.75 -> -3.75 (Bottom to Top)
            // Gote: -3.75 -> 3.75 (Top to Bottom)
            g.position.set(gX, 0, gZ + i * 1.5);
            g.rotation.y = Math.PI;
            g.userData = { type: 'palette', pKey: k, owner: GOTE };
            
            if (state.selected && state.selected.type === 'palette' && state.selected.owner === GOTE && state.selected.pKey === k) {
                g.position.y += 0.3; ((g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0x664422);
            }
            this.scene.add(g); this.meshes.palette.push(g);
        });
    },

    drawHands(state) {
        // Draw pieces on Komadai
        const drawHand = (owner, pieces, standMesh) => {
             if (!standMesh) return;
             const x = standMesh.position.x;
             const z = standMesh.position.z;
             const y = -CONFIG.BOARD_THICKNESS + CONFIG.TABLE_HEIGHT;
             const isS = owner === SENTE;
             
             // Simple grid layout on stand
             pieces.forEach((k, i) => {
                 const g = this.createPieceObject({ type: k, owner: owner, promoted: false });
                 const col = i % 3; 
                 const row = Math.floor(i / 3);
                 // Adjust layout based on stand dimensions
                 const lx = (col - 1) * 1.2;
                 const lz = (row - 1) * 1.5; // Expand outwards?
                 // Sente stand is rotated 90deg. its local X is world Z? 
                 // Actually stand mesh is rotated. Local coords?
                 // No, standard rotation. 
                 // Komadai rotation y = PI/2. 
                 // World coords: 
                 // Sente Stand: pos(0, y, +z). Rot y=90. Local X+ points to World -Z. Local Z+ points to World +X.
                 // It's easier to just use world coords relative to stand center.
                 
                 // If Stand is rotated 90 deg:
                 // Width (x-axis of BoxGeo) is along World Z.
                 // Depth (z-axis of BoxGeo) is along World X.
                 // stand dim: w=4, d=6.
                 // nicely fits pieces.
                 
                 // Let's just place relative to center.
                 // Sente Stand: Width (4) is now Z-span. Depth (6) is X-span.
                 // Wait, geometry is w=4, d=6. 
                 // If rotated 90deg around Y:
                 // The 'w' dimension aligns with Z axis. 'd' dimension aligns with X axis.
                 
                 const sx = (isS ? -1 : 1) * ((row * 1.2) - 1.5); // Random offset logic, fix later if needed
                 const sz = (isS ? 1 : -1) * ((col * 1.2) - 1.2); 
                 
                 // Better layout:
                 // Sente Stand (Bottom): Pieces should face North (User). 
                 // Stand is at Z > 0.
                 g.position.set(x + sx, y, z + sz);
                 if (owner === GOTE) g.rotation.y = Math.PI;

                 if (state.selected && state.selected.type === 'hand' && state.selected.owner === owner && state.selected.index === i) {
                     g.position.y += 0.3; ((g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0x664422);
                 }
                 
                 g.userData = { type: 'hand', index: i, owner: owner };
                 this.scene.add(g); this.meshes.hands.push(g);
             });
        };

        drawHand(SENTE, state.hands.sente, this.meshes.komadai.sente);
        drawHand(GOTE, state.hands.gote, this.meshes.komadai.gote);
    },

    createPieceObject(p) {
        const g = new THREE.Group();

        const hitGeo = new THREE.BoxGeometry(1.6, 1.0, 1.6);
        const hitMat = new THREE.MeshBasicMaterial({ color: 0xff0000, visible: false }); 
        const hitBox = new THREE.Mesh(hitGeo, hitMat);
        hitBox.position.y = 0.25; 
        g.add(hitBox);

        const s = new THREE.Shape();
        s.moveTo(0, 0.9); s.lineTo(0.75, 0.4); s.lineTo(0.75 * 1.1, -0.9); s.lineTo(-0.75 * 1.1, -0.9); s.lineTo(-0.75, 0.4); s.lineTo(0, 0.9);
        const geo = new THREE.ExtrudeGeometry(s, { depth: 0.45, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3 });
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) if (pos.getZ(i) > 0.05) pos.setZ(i, pos.getZ(i) * Math.max(0.1, 1.0 - ((pos.getY(i) + 0.9) * 0.25)));
        geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(255 / 255, 174 / 255, 88 / 255), roughness: 0.4, metalness: 0.1 }));
        m.rotation.x = -Math.PI / 2; m.castShadow = true; m.receiveShadow = true; g.add(m);

        let t = PIECE_TYPES[p.type]?.name || '?';
        if (p.type === 'OU' && p.owner === SENTE) t = '玉';
        if (p.promoted) { 
             if (p.type === 'KAKU') t = '馬';
             else if (p.type === 'HISHA') t = '龍';
             else t = '全';
        }
        
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

    animate(t?) {
        requestAnimationFrame((t) => this.animate(t)); tweenGroup.update(t);
        this.renderer.render(this.scene, this.camera); this.cssRenderer.render(this.scene, this.camera);
    }
};

// --- Main Controller ---
const Main: any = {
    init() {
        this.resetToInitial();
        EditorView.init();
        this.setMode('EDIT'); // Default
    },
    
    setMode(mode) {
        EditorState.mode = mode;
        
        document.getElementById('btn-mode-edit')!.style.background = mode === 'EDIT' ? '#5D4037' : '#A1887F';
        document.getElementById('btn-mode-play')!.style.background = mode === 'PLAY' ? '#5D4037' : '#A1887F';
        
        const help = document.getElementById('help-text')!;
        if (mode === 'EDIT') {
            document.getElementById('editor-controls')!.style.display = 'block';
            help.innerHTML = '<b>[編集モード]</b><br>* 右側のパレットから駒を選択して配置。<br>* 駒台(手前/奥)をクリックで持ち駒に追加。<br>* 枠外ドラッグで削除。';
        } else {
            document.getElementById('editor-controls')!.style.display = 'none';
            help.innerHTML = '<b>[プレイ確認]</b><br>* 盤上の駒を移動（手番無視）。<br>* 持ち駒から「打つ」ことができます。<br>* 取った駒は持ち駒になります。';
        }

        EditorState.selected = null;
        EditorView.render(EditorState);
    },

    resetToInitial() {
        EditorState.reset();
        // Simple initial state example
        EditorState.board[0][1] = { type: 'KAKU', owner: GOTE, promoted: false };
        EditorState.board[0][2] = { type: 'KIN', owner: GOTE, promoted: false };
        EditorState.board[0][3] = { type: 'OU', owner: GOTE, promoted: false };
        EditorState.board[3][0] = { type: 'OU', owner: SENTE, promoted: false };
        EditorState.board[3][1] = { type: 'KIN', owner: SENTE, promoted: false };
        EditorState.board[3][2] = { type: 'KAKU', owner: SENTE, promoted: false };
        if (EditorView.scene) EditorView.render(EditorState);
    },

    clearBoard() {
        EditorState.reset();
        EditorView.render(EditorState);
    },

    toggleUI() {
        const c = document.getElementById('ui-container')!;
        c.classList.toggle('minimized');
    },

    onPointerDown(e) {
        if (e.target.closest('#ui-container') || 
            (document.getElementById('promotion-overlay') && document.getElementById('promotion-overlay')!.style.display === 'flex')) return;

        EditorView.mouse.x = (e.clientX / window.innerWidth) * 2 - 1; 
        EditorView.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        EditorView.raycaster.setFromCamera(EditorView.mouse, EditorView.camera);
        
        // Raycast targets: Pieces, Palette, Hands, Board, Komadai(Stand bases)
        const pieces = [...EditorView.meshes.pieces, ...EditorView.meshes.palette, ...EditorView.meshes.hands].map(g => g.children[0]);
        const stands = [EditorView.meshes.komadai.sente, EditorView.meshes.komadai.gote].filter(m => m);
        const targets = pieces.concat(EditorView.meshes.board).concat(stands);
        
        const intersects = EditorView.raycaster.intersectObjects(targets);

        if (intersects.length > 0) {
            let hit = intersects[0].object;
            // Check if it's a stand base
            const isStand = stands.includes(hit);
            let d: any = null;
            
            if (isStand) {
                d = { type: 'stand', owner: hit === EditorView.meshes.komadai.sente ? SENTE : GOTE };
            } else {
                d = hit.parent && hit.parent.userData.type ? hit.parent.userData : hit.userData;
            }

            if (EditorState.mode === 'EDIT') {
                this.handleEditMode(d);
            } else {
                this.handlePlayMode(d);
            }
        } else {
             // Clicked nothing / void
             if (EditorState.mode === 'EDIT' && EditorState.selected && (EditorState.selected.type === 'board' || EditorState.selected.type === 'hand')) {
                 // Delete from board or hand
                 if (EditorState.selected.type === 'board') {
                     EditorState.board[EditorState.selected.y][EditorState.selected.x] = null;
                 } else if (EditorState.selected.type === 'hand') {
                     EditorState.hands[EditorState.selected.owner].splice(EditorState.selected.index, 1);
                 }
                 EditorState.selected = null;
                 EditorView.render(EditorState);
             } else {
                 EditorState.selected = null;
                 EditorView.render(EditorState);
             }
        }
    },
    
    handleEditMode(d) {
        if (d.type === 'palette' || d.type === 'hand') {
            EditorState.selected = d; 
            EditorView.render(EditorState);
        } else if (d.type === 'board' && d.piece) {
             if (EditorState.selected && EditorState.selected.type === 'board' && EditorState.selected.x === d.x && EditorState.selected.y === d.y) {
                   // Toggle promotion
                   d.piece.promoted = !d.piece.promoted;
                   EditorState.selected = null;
                   EditorView.render(EditorState);
             } else {
                   EditorState.selected = d;
                   EditorView.render(EditorState);
             }
        } else if (d.type === 'stand') {
            // Add to hand
            if (EditorState.selected) {
                 let newType = null;
                 if (EditorState.selected.type === 'palette') newType = EditorState.selected.pKey;
                 else if (EditorState.selected.type === 'board') {
                     const p = EditorState.board[EditorState.selected.y][EditorState.selected.x];
                     newType = p.type; 
                     EditorState.board[EditorState.selected.y][EditorState.selected.x] = null; // Move
                 } else if (EditorState.selected.type === 'hand') {
                     // Move within hand or hand-to-hand? 
                     // For simplicity, if different owner, move. If same, do nothing.
                     if (EditorState.selected.owner !== d.owner) {
                         const k = EditorState.hands[EditorState.selected.owner][EditorState.selected.index];
                         EditorState.hands[EditorState.selected.owner].splice(EditorState.selected.index, 1);
                         newType = k;
                     }
                 }
                 
                 if (newType) {
                     EditorState.hands[d.owner].push(newType);
                     EditorState.selected = null;
                     EditorView.render(EditorState);
                 }
            }
        } else if (d.isBoard) {
            if (EditorState.selected) {
                const toX = d.x;
                const toY = d.y;
                
                let newPiece: any = null;
                if (EditorState.selected.type === 'palette') {
                    newPiece = { type: EditorState.selected.pKey, owner: EditorState.selected.owner, promoted: false };
                } else if (EditorState.selected.type === 'hand') {
                    const k = EditorState.hands[EditorState.selected.owner][EditorState.selected.index];
                    newPiece = { type: k, owner: EditorState.selected.owner, promoted: false };
                    EditorState.hands[EditorState.selected.owner].splice(EditorState.selected.index, 1);
                } else if (EditorState.selected.type === 'board') {
                    const fromX = EditorState.selected.x;
                    const fromY = EditorState.selected.y;
                    newPiece = EditorState.board[fromY][fromX];
                    EditorState.board[fromY][fromX] = null;
                }
                
                if (newPiece) {
                    EditorState.board[toY][toX] = newPiece;
                    EditorState.selected = null;
                    EditorView.render(EditorState);
                }
            }
        }
    },
    
    handlePlayMode(d) {
        if (d.type === 'palette') return; // Ignore palette in play mode
        
        if (d.type === 'hand') {
            // Select from hand
            if (d.owner === SENTE || d.owner === GOTE) { // Allow anyone to move anything
                EditorState.selected = d;
                EditorView.render(EditorState);
            }
        } else if (d.type === 'board' && d.piece) {
             // If selecting an opponent's piece while having a board piece selected => Capture?
             if (EditorState.selected && EditorState.selected.type === 'board') {
                 if (ShogiLogic.isPseudoLegalMove(EditorState.selected, d.x, d.y, EditorState.board)) {
                     this.executeMove(d.x, d.y);
                     return;
                 }
             }
             
             // Select piece
             EditorState.selected = d;
             EditorView.render(EditorState);
        } else if (d.isBoard) {
             if (EditorState.selected) {
                 if (EditorState.selected.type === 'board') {
                     if (ShogiLogic.isPseudoLegalMove(EditorState.selected, d.x, d.y, EditorState.board)) {
                         this.executeMove(d.x, d.y);
                     } else {
                         EditorState.selected = null;
                         EditorView.render(EditorState);
                     }
                 } else if (EditorState.selected.type === 'hand') {
                     // Drop
                     if (EditorState.board[d.y][d.x] === null) {
                         const k = EditorState.hands[EditorState.selected.owner][EditorState.selected.index];
                         // Remove from hand
                         EditorState.hands[EditorState.selected.owner].splice(EditorState.selected.index, 1);
                         
                         EditorState.board[d.y][d.x] = { type: k, owner: EditorState.selected.owner, promoted: false };
                         EditorState.selected = null;
                         EditorView.render(EditorState);
                     }
                 }
             }
        }
    },
    
    executeMove(tx, ty) {
        const fromX = EditorState.selected.x;
        const fromY = EditorState.selected.y;
        const p = EditorState.board[fromY][fromX];
        const targetP = EditorState.board[ty][tx];

        // Capture logic
        if (targetP) {
            const capturedType = targetP.type; // Unpromoted by definition of type key, but if it was promoted on board, we strip it
            // Add to capturer's hand
            EditorState.hands[p.owner].push(capturedType);
        }
        
        // Check promotion
        let promote = false;
        if (!p.promoted) {
             if (p.owner === SENTE && ty === 0) promote = true;
             else if (p.owner === GOTE && ty === 3) promote = true;
        }
        
        const needsOverlay = (!p.promoted && ((p.owner === SENTE && ty === 0) || (p.owner === GOTE && ty === 3)));
        
        if (needsOverlay) {
            this.pendingMove = { fromX, fromY, tx, ty };
            document.getElementById('promotion-overlay')!.style.display = 'flex';
        } else {
            this.commitPlayMove(fromX, fromY, tx, ty, false);
        }
    },
    
    resolvePromotion(promote) {
        document.getElementById('promotion-overlay')!.style.display = 'none';
        if (this.pendingMove) {
            this.commitPlayMove(this.pendingMove.fromX, this.pendingMove.fromY, this.pendingMove.tx, this.pendingMove.ty, promote);
            this.pendingMove = null;
        }
    },
    
    commitPlayMove(fx, fy, tx, ty, promote) {
        const p = EditorState.board[fy][fx];
        EditorState.board[fy][fx] = null;
        
        const newP = { ...p };
        if (promote) newP.promoted = true;
        
        EditorState.board[ty][tx] = newP;
        EditorState.selected = null;
        EditorView.render(EditorState);
    }
};

(window as any).Main = Main;
Main.init();
