import * as THREE from 'three';
import {
    decodeKifu,
    explainMoveIfBad,
    initialState,
    replayKifu,
    type AnalyzeResponse,
    type MoveExplanation,
    type ReplayStep
} from './explain_engine';
import {
    formatAnalysisFeatures,
    type BoardPiece,
    type GameStateSnapshot,
    type MoveRecord,
    type PieceKind,
    type Player
} from './position_diff_analysis';

const SENTE: Player = 'sente';
const GOTE: Player = 'gote';
const CELL_SIZE = 1.85;
const BOARD_SIZE = 4;

const PIECE_TEXT: Record<PieceKind, string> = {
    OU: '玉',
    KIN: '金',
    KAKU: '角',
    UMA: '馬'
};

type PageState = {
    steps: ReplayStep[];
    explanations: MoveExplanation[];
    selectedIndex: number;
    analysisComplete: boolean;
};

const pageState: PageState = {
    steps: [],
    explanations: [],
    selectedIndex: 0,
    analysisComplete: false
};

const boardRoot = document.getElementById('board-root')!;
const statusEl = document.getElementById('status')!;
const selectedDetailEl = document.getElementById('selected-detail')!;
const explanationListEl = document.getElementById('explanation-list')!;
const moveListEl = document.getElementById('move-list')!;
let boardView: ExplainBoard3D;

async function init() {
    boardView = new ExplainBoard3D(boardRoot);
    const encoded = new URLSearchParams(window.location.search).get('m') || '';
    if (!encoded) {
        statusEl.textContent = 'URLに棋譜がありません。対局結果から「解説を見る」を開いてください。';
        boardView.renderState(initialState());
        renderAll();
        return;
    }

    try {
        pageState.steps = replayKifu(decodeKifu(encoded));
    } catch (error) {
        statusEl.textContent = `棋譜を読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`;
        boardView.renderState(initialState());
        renderAll();
        return;
    }

    if (pageState.steps.length === 0) {
        statusEl.textContent = '棋譜が空です。';
        boardView.renderState(initialState());
        renderAll();
        return;
    }

    pageState.selectedIndex = pageState.steps.length - 1;
    boardView.renderState(pageState.steps[pageState.selectedIndex].afterState, pageState.steps[pageState.selectedIndex].move);
    renderAll();
    await analyzeKifu();
}

async function analyzeKifu() {
    for (const step of pageState.steps) {
        statusEl.textContent = `${pageState.steps.length}手中 ${step.moveNumber}手目を解析中...`;
        renderAll();

        try {
            const analysis = await fetchAnalysis(step.beforeState);
            const explanation = explainMoveIfBad(
                step.beforeState,
                step.move,
                step.afterState,
                analysis,
                step.moveNumber,
                step.moveLabel
            );
            if (explanation) {
                pageState.explanations.push(explanation);
            }
        } catch (error) {
            statusEl.textContent = `解析APIでエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`;
            pageState.analysisComplete = true;
            renderAll();
            return;
        }
    }

    pageState.analysisComplete = true;
    const firstBadMove = pageState.explanations[0];
    if (firstBadMove) {
        selectMove(firstBadMove.moveNumber - 1);
    }
    statusEl.textContent = `${pageState.steps.length}手の解析が完了しました。`;
    renderAll();
}

async function fetchAnalysis(state: GameStateSnapshot): Promise<AnalyzeResponse> {
    const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state })
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
}

function renderAll() {
    renderSelectedDetail();
    renderExplanationList();
    renderMoveList();
}

function renderSelectedDetail() {
    const step = pageState.steps[pageState.selectedIndex];
    if (!step) {
        selectedDetailEl.innerHTML = '<div class="selected-title">開始局面</div><div>棋譜を選ぶと3D盤面に表示します。</div>';
        return;
    }

    const explanation = explanationForMove(step.moveNumber);
    const body = explanation
        ? explanationText(explanation)
        : 'この手は、現時点では構造的な悪化として表示する内容がありません。';

    selectedDetailEl.innerHTML = `
        <div class="selected-title">${step.moveNumber}手目 ${escapeHtml(step.moveLabel)}</div>
        <div>${escapeHtml(body)}</div>
    `;
}

function renderExplanationList() {
    explanationListEl.innerHTML = '';

    if (pageState.explanations.length === 0) {
        const message = document.createElement('div');
        message.className = 'selected-detail';
        message.textContent = pageState.analysisComplete
            ? '悪手は検出されませんでした。'
            : '解析中です。悪手が見つかるとここに表示します。';
        explanationListEl.appendChild(message);
        return;
    }

    pageState.explanations.forEach(explanation => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'explain-item';
        button.innerHTML = `
            <span class="item-title">${explanation.moveNumber}手目 ${escapeHtml(explanation.moveLabel)}</span>
            <span class="item-message">${escapeHtml(explanationText(explanation))}</span>
        `;
        button.addEventListener('click', () => selectMove(explanation.moveNumber - 1));
        explanationListEl.appendChild(button);
    });
}

function renderMoveList() {
    moveListEl.innerHTML = '';

    pageState.steps.forEach((step, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'move-item';
        if (index === pageState.selectedIndex) button.classList.add('is-selected');
        if (explanationForMove(step.moveNumber)) button.classList.add('has-explanation');
        const turnMark = step.moveNumber % 2 === 1 ? '▲' : '△';
        button.textContent = `${step.moveNumber}. ${turnMark}${step.moveLabel}`;
        button.addEventListener('click', () => selectMove(index));
        moveListEl.appendChild(button);
    });
}

function selectMove(index: number) {
    const step = pageState.steps[index];
    if (!step) return;
    pageState.selectedIndex = index;
    boardView.renderState(step.afterState, step.move);
    renderAll();
}

function explanationForMove(moveNumber: number): MoveExplanation | undefined {
    return pageState.explanations.find(explanation => explanation.moveNumber === moveNumber);
}

function explanationText(explanation: MoveExplanation): string {
    if (explanation.features.length === 0) {
        return '完全解析DBでは最善候補より悪い手ですが、局面構造の悪化は検出できませんでした。';
    }
    return formatAnalysisFeatures(explanation.features);
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

class ExplainBoard3D {
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    private readonly renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    private readonly dynamicObjects: THREE.Object3D[] = [];

    constructor(private readonly root: HTMLElement) {
        this.scene.background = new THREE.Color(0x101010);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.shadowMap.enabled = true;
        this.root.appendChild(this.renderer.domElement);

        this.camera.position.set(0, 9.5, 9);
        this.camera.lookAt(0, 0, 0);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
        const light = new THREE.DirectionalLight(0xffffff, 1.2);
        light.position.set(5, 12, 8);
        light.castShadow = true;
        this.scene.add(light);

        this.createBoard();
        this.resize();
        window.addEventListener('resize', () => this.resize());
        this.animate();
    }

    renderState(state: GameStateSnapshot, move?: MoveRecord) {
        this.clearDynamicObjects();
        if (move?.type === 'board' || move?.type === 'hand') {
            this.addHighlight(move.toX, move.toY);
        }

        for (let y = 0; y < BOARD_SIZE; y++) {
            for (let x = 0; x < BOARD_SIZE; x++) {
                const piece = state.board[y][x];
                if (!piece) continue;
                const group = this.createPiece(piece);
                group.position.set(boardX(x), 0.18, boardZ(y));
                this.addDynamic(group);
            }
        }

        this.renderHand(state.hands[SENTE], SENTE);
        this.renderHand(state.hands[GOTE], GOTE);
    }

    private createBoard() {
        const boardWidth = CELL_SIZE * BOARD_SIZE + 0.75;
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(boardWidth, 0.45, boardWidth),
            new THREE.MeshStandardMaterial({ color: 0xd6a35f, roughness: 0.55 })
        );
        base.position.y = -0.08;
        base.receiveShadow = true;
        this.scene.add(base);

        const grid = new THREE.Group();
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0x2f211b });
        const half = (CELL_SIZE * BOARD_SIZE) / 2;
        for (let i = 0; i <= BOARD_SIZE; i++) {
            const pos = -half + i * CELL_SIZE;
            grid.add(new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(pos, 0.17, -half),
                    new THREE.Vector3(pos, 0.17, half)
                ]),
                lineMaterial
            ));
            grid.add(new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(-half, 0.17, pos),
                    new THREE.Vector3(half, 0.17, pos)
                ]),
                lineMaterial
            ));
        }
        this.scene.add(grid);
    }

    private createPiece(piece: BoardPiece): THREE.Group {
        const group = new THREE.Group();
        if (piece.owner === GOTE) group.rotation.y = Math.PI;

        const base = new THREE.Mesh(
            new THREE.BoxGeometry(1.18, 0.22, 1.38),
            new THREE.MeshStandardMaterial({ color: 0xf0bc78, roughness: 0.42 })
        );
        base.castShadow = true;
        base.receiveShadow = true;
        group.add(base);

        const texture = createPieceTexture(piece);
        const label = new THREE.Mesh(
            new THREE.PlaneGeometry(1.06, 1.22),
            new THREE.MeshBasicMaterial({ map: texture, transparent: true })
        );
        label.rotation.x = -Math.PI / 2;
        label.position.y = 0.116;
        group.add(label);

        return group;
    }

    private renderHand(hand: PieceKind[], owner: Player) {
        const z = owner === SENTE ? 4.6 : -4.6;
        const startX = -Math.min(hand.length, 5) * 0.55;
        hand.forEach((piece, index) => {
            const group = this.createPiece({ type: piece, owner, promoted: false });
            group.scale.setScalar(0.72);
            group.position.set(startX + index * 0.8, 0.14, z);
            this.addDynamic(group);
        });
    }

    private addHighlight(x: number, y: number) {
        const highlight = new THREE.Mesh(
            new THREE.PlaneGeometry(CELL_SIZE * 0.9, CELL_SIZE * 0.9),
            new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.36, side: THREE.DoubleSide })
        );
        highlight.rotation.x = -Math.PI / 2;
        highlight.position.set(boardX(x), 0.19, boardZ(y));
        this.addDynamic(highlight);
    }

    private addDynamic(object: THREE.Object3D) {
        this.dynamicObjects.push(object);
        this.scene.add(object);
    }

    private clearDynamicObjects() {
        for (const object of this.dynamicObjects) {
            this.scene.remove(object);
        }
        this.dynamicObjects.length = 0;
    }

    private resize() {
        const width = this.root.clientWidth || window.innerWidth;
        const height = this.root.clientHeight || window.innerHeight;
        this.camera.aspect = width / Math.max(height, 1);
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    private animate() {
        requestAnimationFrame(() => this.animate());
        this.renderer.render(this.scene, this.camera);
    }
}

function createPieceTexture(piece: BoardPiece): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = piece.promoted || piece.type === 'UMA' ? '#b71c1c' : '#1d1512';
    ctx.font = 'bold 118px "Hiragino Mincho ProN", "Yu Mincho", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = pieceText(piece);
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 6);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function pieceText(piece: BoardPiece): string {
    if (piece.type === 'OU' && piece.owner === SENTE) return '玉';
    if (piece.promoted || piece.type === 'UMA') return '馬';
    return PIECE_TEXT[piece.type];
}

function boardX(x: number): number {
    return (x - (BOARD_SIZE - 1) / 2) * CELL_SIZE;
}

function boardZ(y: number): number {
    return (y - (BOARD_SIZE - 1) / 2) * CELL_SIZE;
}

void init();
