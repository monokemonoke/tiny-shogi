import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
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
const CELL_SIZE = 2.0;
const BOARD_SIZE = 4;
const BOARD_PADDING = 0.8;
const BOARD_THICKNESS = 1.5;
const TABLE_HEIGHT = 1.2;

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
const issueSummaryEl = document.getElementById('issue-summary')!;
const scoreGapEl = document.getElementById('score-gap')!;
const featureListEl = document.getElementById('feature-list')!;
const previousMoveButton = document.getElementById('previous-move') as HTMLButtonElement;
const nextMoveButton = document.getElementById('next-move') as HTMLButtonElement;
let boardView: ExplainBoard3D;

previousMoveButton.addEventListener('click', () => selectMove(pageState.selectedIndex - 1));
nextMoveButton.addEventListener('click', () => selectMove(pageState.selectedIndex + 1));

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
    renderAnalysisCard();
    renderExplanationList();
    renderMoveList();
    renderTimelineControls();
}

function renderSelectedDetail() {
    const step = pageState.steps[pageState.selectedIndex];
    if (!step) {
        selectedDetailEl.innerHTML = `
            <div class="selected-title-row">
                <div class="selected-title">開始局面</div>
                <span class="neutral-badge">準備中</span>
            </div>
            <div>棋譜を選ぶと3D盤面に表示します。</div>
        `;
        return;
    }

    const explanation = explanationForMove(step.moveNumber);
    const body = explanation
        ? explanationText(explanation)
        : 'この手は、現時点では構造的な悪化として表示する内容がありません。';
    const badgeClass = explanation ? 'bad-badge' : 'neutral-badge';
    const badgeText = explanation ? '悪手' : '通常';

    selectedDetailEl.innerHTML = `
        <div class="selected-title-row">
            <div class="selected-title">${step.moveNumber}手目 ${escapeHtml(step.moveLabel)}</div>
            <span class="${badgeClass}">${badgeText}</span>
        </div>
        <div>${escapeHtml(body)}</div>
    `;
}

function renderAnalysisCard() {
    const step = pageState.steps[pageState.selectedIndex];
    if (!step) {
        issueSummaryEl.textContent = '棋譜を解析すると、選択中の手の問題点を表示します。';
        scoreGapEl.textContent = '';
        featureListEl.innerHTML = '<div class="empty-card">表示できる見直しポイントはまだありません。</div>';
        return;
    }

    const explanation = explanationForMove(step.moveNumber);
    if (!explanation) {
        issueSummaryEl.textContent = 'この手は悪手として検出されていません。';
        scoreGapEl.innerHTML = '<span>最善候補との差</span><span class="score-gap-value">0</span>';
        featureListEl.innerHTML = '<div class="empty-card">構造的な悪化は検出されていません。</div>';
        return;
    }

    issueSummaryEl.textContent = explanationText(explanation);
    scoreGapEl.innerHTML = `
        <span>最善候補との差</span>
        <span class="score-gap-value">${escapeHtml(formatScoreGap(explanation.bestScore - explanation.actualScore))}</span>
    `;
    featureListEl.innerHTML = explanation.features.length > 0
        ? explanation.features.map(feature => `
            <div class="feature-item">
                <div class="feature-title">
                    <span>${escapeHtml(featureTitle(feature.kind))}</span>
                    <span class="severity-badge ${feature.severity}">${escapeHtml(severityLabel(feature.severity))}</span>
                </div>
                <div>${escapeHtml(feature.message)}</div>
            </div>
        `).join('')
        : '<div class="empty-card">差分から説明できる局面変化は見つかりませんでした。</div>';
}

function renderExplanationList() {
    explanationListEl.innerHTML = '';

    if (pageState.explanations.length === 0) {
        const message = document.createElement('div');
        message.className = 'empty-card';
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
        if (explanation.moveNumber - 1 === pageState.selectedIndex) button.classList.add('is-selected');
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
        button.innerHTML = `
            <span class="move-number">${step.moveNumber}</span>
            <span class="move-label">${turnMark}${escapeHtml(step.moveLabel)}</span>
        `;
        if (index === pageState.selectedIndex) {
            button.setAttribute('aria-current', 'step');
            queueMicrotask(() => button.scrollIntoView({ block: 'nearest', inline: 'center' }));
        }
        button.addEventListener('click', () => selectMove(index));
        moveListEl.appendChild(button);
    });
}

function renderTimelineControls() {
    previousMoveButton.disabled = pageState.selectedIndex <= 0;
    nextMoveButton.disabled = pageState.selectedIndex >= pageState.steps.length - 1;
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

function formatScoreGap(gap: number): string {
    const roundedGap = Math.max(0, Math.round(gap));
    if (roundedGap >= 10000) return '大';
    return String(roundedGap);
}

function featureTitle(kind: MoveExplanation['features'][number]['kind']): string {
    switch (kind) {
        case 'kingDangerIncreased':
            return '玉の危険度';
        case 'escapeSquaresReduced':
            return '逃げ道';
        case 'checkOccurred':
            return '王手';
        case 'defenderMoved':
            return '守り駒';
        case 'lineOpened':
            return '利き筋';
        case 'pieceHanging':
            return '浮き駒';
    }
}

function severityLabel(severity: MoveExplanation['features'][number]['severity']): string {
    switch (severity) {
        case 'high':
            return '重要';
        case 'medium':
            return '注意';
        case 'low':
            return '軽微';
    }
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
    private readonly cssRenderer = new CSS3DRenderer();
    private readonly dynamicObjects: THREE.Object3D[] = [];
    private readonly boardWidth = BOARD_SIZE * CELL_SIZE + BOARD_PADDING * 2;

    constructor(private readonly root: HTMLElement) {
        this.scene.background = new THREE.Color(0x000000);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.root.appendChild(this.renderer.domElement);

        this.cssRenderer.domElement.style.position = 'absolute';
        this.cssRenderer.domElement.style.top = '0';
        this.cssRenderer.domElement.style.left = '0';
        this.cssRenderer.domElement.style.pointerEvents = 'none';
        this.root.appendChild(this.cssRenderer.domElement);

        this.camera.position.set(0, 12.5, 3);
        this.camera.lookAt(0, -1, 0);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const light = new THREE.DirectionalLight(0xffffff, 1.2);
        light.position.set(5, 15, 10);
        light.castShadow = true;
        this.scene.add(light);

        this.createEnvironment();
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
                group.position.set(boardX(x), 0, boardZ(y));
                if (piece.owner === GOTE) group.rotation.y = Math.PI;
                this.addDynamic(group);
            }
        }

        this.renderHand(state.hands[SENTE], SENTE);
        this.renderHand(state.hands[GOTE], GOTE);
    }

    private createEnvironment() {
        const tatami = new THREE.Mesh(
            new THREE.PlaneGeometry(60, 60),
            new THREE.MeshStandardMaterial({ map: this.createTexture('tatami'), roughness: 0.8 })
        );
        tatami.rotation.x = -Math.PI / 2;
        tatami.position.y = -BOARD_THICKNESS - 0.1;
        tatami.receiveShadow = true;
        this.scene.add(tatami);

        const woodTexture = this.createTexture('wood_light');
        const boardMaterials = Array(6).fill(null).map((_, index) =>
            new THREE.MeshStandardMaterial({
                map: index === 2 ? this.createTexture('grid') : woodTexture,
                roughness: 0.2,
                metalness: 0.05
            })
        );
        const board = new THREE.Mesh(
            new THREE.BoxGeometry(this.boardWidth, BOARD_THICKNESS, this.boardWidth),
            boardMaterials
        );
        board.position.set(0, -BOARD_THICKNESS / 2, 0);
        board.castShadow = true;
        board.receiveShadow = true;
        this.scene.add(board);

        const standMaterial = new THREE.MeshStandardMaterial({
            map: this.createTexture('wood_dark'),
            roughness: 0.2,
            metalness: 0.05
        });
        const standWidth = 4.0;
        const standDepth = 6.0;
        const offset = this.boardWidth / 2 + standWidth / 2 + 0.5;
        const senteStand = new THREE.Mesh(new THREE.BoxGeometry(standWidth, TABLE_HEIGHT, standDepth), standMaterial);
        senteStand.position.set(offset, -BOARD_THICKNESS + TABLE_HEIGHT / 2, 1);
        senteStand.castShadow = true;
        senteStand.receiveShadow = true;
        this.scene.add(senteStand);

        const goteStand = new THREE.Mesh(new THREE.BoxGeometry(standWidth, TABLE_HEIGHT, standDepth), standMaterial.clone());
        goteStand.position.set(-offset, -BOARD_THICKNESS + TABLE_HEIGHT / 2, -1);
        goteStand.castShadow = true;
        goteStand.receiveShadow = true;
        this.scene.add(goteStand);
    }

    private createPiece(piece: BoardPiece): THREE.Group {
        const group = new THREE.Group();
        const shape = new THREE.Shape();
        shape.moveTo(0, 0.9);
        shape.lineTo(0.75, 0.4);
        shape.lineTo(0.75 * 1.1, -0.9);
        shape.lineTo(-0.75 * 1.1, -0.9);
        shape.lineTo(-0.75, 0.4);
        shape.lineTo(0, 0.9);

        const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: 0.45,
            bevelEnabled: true,
            bevelThickness: 0.03,
            bevelSize: 0.03,
            bevelSegments: 3
        });
        const positions = geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) {
            if (positions.getZ(i) > 0.05) {
                positions.setZ(i, positions.getZ(i) * Math.max(0.1, 1.0 - ((positions.getY(i) + 0.9) * 0.25)));
            }
        }
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
                color: new THREE.Color(255 / 255, 174 / 255, 88 / 255),
                roughness: 0.4,
                metalness: 0.1
            })
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);

        const label = document.createElement('div');
        label.className = 'piece-text';
        if (piece.promoted || piece.type === 'UMA') label.classList.add('promoted-text');
        label.textContent = pieceText(piece);
        const cssObject = new CSS3DObject(label);
        cssObject.scale.set(0.007, 0.007, 0.007);
        cssObject.position.set(0, 0.36, 0.1);
        cssObject.rotation.x = -Math.PI / 2 - 0.15;
        group.add(cssObject);

        return group;
    }

    private renderHand(hand: PieceKind[], owner: Player) {
        const x = owner === SENTE ? this.boardWidth / 2 + 2.5 : -this.boardWidth / 2 - 2.5;
        const zStart = -1.5;
        hand.forEach((piece, index) => {
            const group = this.createPiece({ type: piece, owner, promoted: false });
            if (owner === GOTE) group.rotation.y = Math.PI;
            const col = index % 2;
            const row = Math.floor(index / 2);
            group.position.set(x + (col - 0.5) * 1.5, -BOARD_THICKNESS + TABLE_HEIGHT, zStart + row * 1.5);
            this.addDynamic(group);
        });
    }

    private addHighlight(x: number, y: number) {
        const highlight = new THREE.Mesh(
            new THREE.PlaneGeometry(CELL_SIZE * 0.9, CELL_SIZE * 0.9),
            new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.36, side: THREE.DoubleSide })
        );
        highlight.rotation.x = -Math.PI / 2;
        highlight.position.set(boardX(x), 0.04, boardZ(y));
        this.addDynamic(highlight);
    }

    private addDynamic(object: THREE.Object3D) {
        this.dynamicObjects.push(object);
        this.scene.add(object);
    }

    private clearDynamicObjects() {
        for (const object of this.dynamicObjects) {
            this.scene.remove(object);
            this.cleanupObject(object);
        }
        this.dynamicObjects.length = 0;
    }

    private resize() {
        const width = this.root.clientWidth || window.innerWidth;
        const height = this.root.clientHeight || window.innerHeight;
        this.camera.aspect = width / Math.max(height, 1);
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
        this.cssRenderer.setSize(width, height);
    }

    private animate() {
        requestAnimationFrame(() => this.animate());
        this.renderer.render(this.scene, this.camera);
        this.cssRenderer.render(this.scene, this.camera);
    }

    private createTexture(type: 'tatami' | 'grid' | 'wood_light' | 'wood_dark'): THREE.CanvasTexture {
        if (type === 'tatami') {
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#c8c290';
            ctx.fillRect(0, 0, 256, 256);
            ctx.fillStyle = '#b8b280';
            for (let y = 0; y < 256; y += 4) {
                if ((y / 4) % 2 === 0) ctx.fillRect(0, y, 256, 2);
            }
            ctx.fillStyle = '#2d4536';
            ctx.fillRect(0, 0, 10, 256);
            ctx.fillRect(246, 0, 10, 256);
            const texture = new THREE.CanvasTexture(canvas);
            texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            texture.repeat.set(8, 8);
            texture.colorSpace = THREE.SRGBColorSpace;
            return texture;
        }

        if (type === 'grid') {
            const canvasWidth = 1024;
            const canvasHeight = 1024;
            const canvas = document.createElement('canvas');
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#D7A55F';
            ctx.fillRect(0, 0, canvasWidth, canvasHeight);
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = '#8d6e63';
            for (let i = 0; i < 300; i++) {
                ctx.fillRect(Math.random() * canvasWidth, 0, Math.random() * 5 + 2, canvasHeight);
            }
            ctx.globalAlpha = 1;

            const gridWidth = canvasWidth * ((BOARD_SIZE * CELL_SIZE) / this.boardWidth);
            const margin = (canvasWidth - gridWidth) / 2;
            const cell = gridWidth / BOARD_SIZE;
            ctx.strokeStyle = '#111';
            ctx.lineWidth = 5;
            ctx.beginPath();
            for (let i = 1; i < BOARD_SIZE; i++) {
                ctx.moveTo(margin + i * cell, margin);
                ctx.lineTo(margin + i * cell, margin + gridWidth);
                ctx.moveTo(margin, margin + i * cell);
                ctx.lineTo(margin + gridWidth, margin + i * cell);
            }
            ctx.stroke();
            ctx.strokeRect(margin, margin, gridWidth, gridWidth);

            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            return texture;
        }

        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = type === 'wood_dark' ? '#5d4037' : '#D7A55F';
        ctx.fillRect(0, 0, 512, 512);
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = type === 'wood_dark' ? '#3e2723' : '#B08040';
        for (let i = 0; i < 100; i++) {
            ctx.fillRect(Math.random() * 512, 0, Math.random() * 50 + 10, 512);
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
    }

    private cleanupObject(object: THREE.Object3D) {
        object.traverse(child => {
            const mesh = child as THREE.Mesh;
            mesh.geometry?.dispose?.();
            const material = mesh.material;
            if (Array.isArray(material)) {
                material.forEach(item => item.dispose());
            } else {
                material?.dispose?.();
            }

            const cssObject = child as CSS3DObject;
            if (cssObject.element?.parentNode) {
                cssObject.element.parentNode.removeChild(cssObject.element);
            }
        });
    }
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
