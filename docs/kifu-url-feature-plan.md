# 棋譜URL機能 実装プラン

## 概要

対局中の棋譜をURLに保持し、待った/進む操作や勝敗後の振り返りを可能にする。

---

## 要件サマリ

| 項目 | 仕様 |
|------|------|
| 戻す/進む | 1手ずつ（Undo/Redo） |
| 待った制限 | なし |
| URL更新 | 各手ごとにリアルタイム |
| 勝敗後UI | ◀ ▶ ボタンで1手ずつ閲覧 |
| 評価値グラフ | クリックで局面ジャンプ |
| URL共有後の挙動 | 振り返りモードで開く |

---

## Phase 1: 棋譜エンコード/デコード

### 1-1. エンコード形式の設計

**形式:** 1手 = 3〜4文字のURL安全文字列

```
盤上移動: [from][to][promote?]
  from: 2文字 (例: "11" = 1一)
  to:   2文字 (例: "21" = 2一)
  promote: "+" があれば成り
  例: "1121" = 1一→2一、"1121+" = 1一→2一成り

駒打ち: [piece][to]
  piece: 1文字 (G=金, S=銀, K=角, H=飛, P=歩)
  to: 2文字
  例: "G21" = 金を2一に打つ
```

**手順の連結:** `-` 区切り
```
例: ?k=1121-G32-2232+-H11
```

### 1-2. 実装: KifuCodec モジュール

```typescript
const KifuCodec = {
  // 座標変換: 内部(x,y) ↔ 棋譜表記(列行)
  // x=0,y=0 → "41" (右上が4一)
  coordToStr(x: number, y: number): string,
  strToCoord(s: string): { x: number, y: number },

  // 1手エンコード
  encodeMove(move: MoveRecord): string,

  // 1手デコード
  decodeMove(s: string): MoveRecord,

  // 全手順エンコード
  encode(moves: MoveRecord[]): string,

  // 全手順デコード
  decode(s: string): MoveRecord[],
};
```

### 1-3. MoveRecord 型の定義

現在の `history` はスナップショットのみ。差分情報を追加する。

```typescript
interface MoveRecord {
  type: 'board' | 'hand';
  fromX?: number;  // 盤上移動時
  fromY?: number;
  toX: number;
  toY: number;
  piece: string;   // 駒種 (OU, KIN, GIN, KAKU, HISHA, FU)
  promote?: boolean;
}
```

---

## Phase 2: 履歴管理の拡張

### 2-1. GameState.history の拡張

```typescript
GameState: {
  // 既存
  history: HistoryEntry[],

  // 新規追加
  moveRecords: MoveRecord[],  // エンコード用の差分リスト
  redoStack: HistoryEntry[],  // Redo用スタック
  redoMoves: MoveRecord[],    // Redo用の差分リスト
}
```

### 2-2. commitMove の修正

- `moveRecords` に差分情報を追加
- `redoStack` / `redoMoves` をクリア（新しい手を指したらRedoは無効）

### 2-3. undoMove の修正

- 現状態を `redoStack` / `redoMoves` に退避
- `history` から復元

### 2-4. redoMove の新規追加

- `redoStack` から復元
- `history` / `moveRecords` に再追加

---

## Phase 3: URL同期

### 3-1. URLへの書き込み

各手後に `history.replaceState` でURLを更新。

```typescript
function updateURL() {
  const kifu = KifuCodec.encode(GameState.moveRecords);
  const url = new URL(window.location.href);
  url.searchParams.set('k', kifu);
  history.replaceState(null, '', url.toString());
}
```

### 3-2. URLからの読み込み

ページロード時にクエリをパースし、振り返りモードで初期化。

```typescript
function loadFromURL() {
  const params = new URLSearchParams(window.location.search);
  const kifu = params.get('k');
  if (kifu) {
    const moves = KifuCodec.decode(kifu);
    enterReviewMode(moves);
  }
}
```

---

## Phase 4: UI - 対局中の操作

### 4-1. ボタン配置

既存の「待った」ボタンを拡張：

```
[ ◀ 戻る ] [ 進む ▶ ] [ リセット ]
```

### 4-2. ボタン状態制御

| 状態 | 戻る | 進む |
|------|------|------|
| 初期局面 | disabled | disabled |
| 対局中 | enabled | disabled（redoなし）/ enabled（redoあり）|
| 振り返りモード | 先頭でdisabled | 最後尾でdisabled |

---

## Phase 5: 振り返りモード

### 5-1. モード定義

```typescript
GameState.reviewMode: boolean;     // 振り返り中か
GameState.reviewIndex: number;     // 現在表示中の手数
```

### 5-2. 振り返りモードの挙動

- AIは動かない
- クリック操作は無効
- ◀ ▶ ボタンのみ有効
- 盤面は表示のみ

### 5-3. 振り返りモードへの遷移

1. **URL経由:** クエリパラメータ `k` がある場合
2. **勝敗確定後:** ゲームオーバー画面から「棋譜を見る」ボタン

---

## Phase 6: 評価値グラフ連携

### 6-1. グラフクリックでジャンプ

```typescript
evalGraph.on('click', (index) => {
  jumpToMove(index);
});
```

### 6-2. 現在位置の強調

振り返り中、グラフ上の現在位置をマーカーで表示。

---

## 実装順序

| Phase | 内容 | 依存 |
|-------|------|------|
| 1 | KifuCodec モジュール | なし |
| 2 | 履歴管理の拡張 | Phase 1 |
| 3 | URL同期 | Phase 1, 2 |
| 4 | 対局中UI (Undo/Redo ボタン) | Phase 2 |
| 5 | 振り返りモード | Phase 2, 3 |
| 6 | 評価値グラフ連携 | Phase 5, 既存グラフ実装 |

---

## 座標系メモ

4x4盤の座標対応（将棋表記 ↔ 内部座標）:

```
将棋表記:  4一 3一 2一 1一
           4二 3二 2二 1二
           4三 3三 2三 1三
           4四 3四 2四 1四

内部(x,y): (0,0)(1,0)(2,0)(3,0)
           (0,1)(1,1)(2,1)(3,1)
           (0,2)(1,2)(2,2)(3,2)
           (0,3)(1,3)(2,3)(3,3)

変換: 列 = 4 - x, 行 = y + 1
      x = 4 - 列, y = 行 - 1
```

---

## 補足: 既存コードへの影響

| ファイル | 変更内容 |
|----------|----------|
| `game.ts` | KifuCodec追加、GameState拡張、commitMove/undoMove修正、redoMove追加、reviewMode実装 |
| `game.html` | ◀ ▶ ボタン追加、振り返りモード用のオーバーレイ調整 |
