# 問題解決計画: ブラウザクラッシュの根本対策

## 結論

**Cloudflare D1 (SQLite) を採用**

理由:
- クライアント側メモリ問題を根本解決
- 無料枠5GBで十分（現在1.7GB）
- Workers統合が容易

---

## 実装計画

### Phase 1: SQLiteエクスポート (Rust)

`src/main.rs`に追加:

```rust
"export_sqlite" => {
    let conn = Connection::open("data/lookup.db")?;
    conn.execute("CREATE TABLE results (hash TEXT PRIMARY KEY, value TEXT)", [])?;
    
    let mut stmt = conn.prepare("INSERT INTO results VALUES (?, ?)")?;
    for (hash, result) in results.iter() {
        stmt.execute(params![hash.to_string(), serde_json::to_string(result)?])?;
    }
}
```

### Phase 2: D1セットアップ

```bash
# D1データベース作成
wrangler d1 create minishogi-lookup

# データインポート
wrangler d1 execute minishogi-lookup --file=data/lookup.db
```

### Phase 3: Workers API (`functions/api/analyze.js`)

```javascript
export async function onRequest({ request, env }) {
  const { state } = await request.json();
  const hash = calcHash(state);  // JS側と同じロジック
  
  // 現在の評価値
  const { results } = await env.DB.prepare(
    "SELECT value FROM results WHERE hash = ?"
  ).bind(hash).first();
  
  // 合法手の評価値（一括クエリ）
  const nextStates = generateNextStates(state);
  const hashes = nextStates.map(s => calcHash(s));
  const placeholders = hashes.map(() => "?").join(",");
  const { results: moveResults } = await env.DB.prepare(
    `SELECT hash, value FROM results WHERE hash IN (${placeholders})`
  ).bind(...hashes).all();
  
  return Response.json({ current: results, moves: moveResults });
}
```

### Phase 4: クライアント修正

```javascript
// 既存のfetch先を変更するだけ
const response = await fetch('/api/analyze', {
  method: 'POST',
  body: JSON.stringify({ state: gameState })
});
```

---

## 必要ファイル

```
functions/
  api/
    analyze.js    # Workers API
wrangler.toml     # D1バインディング設定
```

## 検証

1. `wrangler dev`でローカル確認
2. Pagesデプロイ後、ブラウザで動作確認
