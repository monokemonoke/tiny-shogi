# Cloudflare Pages 移行計画

Rustサーバーを不要にし、Cloudflare Pagesのみで動作させる。

## 現状の課題

- `data/analysis_results.bin` (約840MB): `HashMap<u128, GameResult>` をbincodeでシリアライズ
- Rustサーバーの`/analyze`エンドポイント:
  1. クライアントからStateを受信
  2. ハッシュ計算 → 評価値ルックアップ
  3. `state.next()` で合法手を生成 → 各手のハッシュで評価値ルックアップ
  4. JSON応答

**問題点**: Cloudflare Pages/Workersでは840MBのバイナリを起動時にロードできない

## 解決アプローチ

### Phase 1: データ分割ツール (Rust)

ハッシュ上位1バイト(00-FF)で256個のJSONファイルに分割:

```
data/lookup/
  00.json  # {"0000...": "Win(5)", "0012...": "Lose(3)", ...}
  01.json
  ...
  ff.json
```

**フォーマット**: 
```json
{
  "0000000000000000000000000000ABCD": {"Win": 5},
  "0000000000000000000000000000EFGH": {"Lose": 3},
  "0000000000000000000000000000IJKL": "Unknown"
}
```

期待サイズ: 約256個 × 3-4MB = 約800MB (gzip後 約100-200MB)

### Phase 2: クライアント側ロジック移植 (JavaScript)

Rustの`State`相当のロジックをJSに移植:

| Rust | JavaScript |
|------|------------|
| `state.to_u128()` | `calcHash(state)` |
| `state.next()` | `generateLegalMoves(state)` |
| `detect_move_str()` | `getMoveString(before, after)` |

### Phase 3: クライアント改修 (`game.html`)

```javascript
// 従来: POST /analyze → Rustサーバー
// 新規: 
async function analyze() {
  const hash = calcHash(gameState);      // JS で計算
  const bucket = hash.substring(0, 2);   // 上位1バイト
  
  // 1. 現在の評価値を取得
  const data = await fetch(`/data/lookup/${bucket}.json`).then(r => r.json());
  const currentEval = data[hash] ?? "Unknown";
  
  // 2. 合法手を生成 & 各手の評価値を取得
  const nextMoves = generateLegalMoves(gameState);
  for (const move of nextMoves) {
    const nextHash = calcHash(move.state);
    const nextBucket = nextHash.substring(0, 2);
    // バケットが異なる場合のみfetch
    move.result = await getEvaluation(nextHash);
  }
  
  updateUI(currentEval, nextMoves);
}
```

## 必要な作業

### 1. Rustツール追加

`src/main.rs`に`export_json`コマンドを追加:

```rust
"export_json" => {
    export_to_json_buckets();
}
```

### 2. JavaScript実装

- [ ] `calcHash(state)`: u128ハッシュ計算 (BigInt使用)
- [ ] `generateLegalMoves(state)`: 合法手生成
- [ ] `getMoveString(before, after)`: 指し手表記
- [ ] `fetchEvaluation(hash)`: JSONバケットからルックアップ (キャッシュ付き)

### 3. デプロイ

- `data/lookup/*.json` を Cloudflare Pages にデプロイ
- `game.html` をそのまま Pages で配信

## 検証方法

1. **ローカル動作確認**: 
   - `python3 -m http.server 8080` でHTML配信
   - ブラウザで開き、盤面操作後にAI応答・評価表示が正常か確認

2. **Rust/JS比較テスト**:
   - 初期局面・数手後の局面で、Rust版とJS版のハッシュ値が一致することを確認

## 注意点

- 合法手が多い局面では、複数バケットをfetchする可能性あり → 並列fetchで対応
- gzip圧縮されたファイルをPages経由で配信するとCDNが自動解凍するため、追加対応不要
