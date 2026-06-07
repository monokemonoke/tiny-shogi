# Tiny Shogi MCP Server

ローカルの `src/solver/data/lookup.db` を直接参照する Tiny 将棋解析用 MCP server です。

## セットアップ

```bash
cd src/mcp
npm install
npm run build
```

## 起動

```bash
cd src/mcp
node dist/server.js
```

別のDBを使う場合は `LOOKUP_DB_PATH` を指定します。

```bash
LOOKUP_DB_PATH=/path/to/lookup.db node dist/server.js
```

## 公開ツール

- `decode_kifu`: `m=`文字列またはURLを再生し、各手の局面列を返します。
- `evaluate_position`: 局面を `lookup.db` の真値で評価します。
- `analyze_moves`: 全合法手と着手後評価、最善手/緩手/敗着/悪手の分類を返します。
- `get_best_line`: 最善応手列を反復導出します。タイは複数候補として返します。
- `describe_position`: 王手、取れる駒、玉距離などの幾何情報を返します。

`lookup.db` の評価は常に手番側視点です。`analyze_moves` では着手後局面が相手番になるため、指し手側視点へ反転した値で分類しています。
