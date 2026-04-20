# Tiny 将棋

このリポジトリは、元プロジェクトから生成した公開用リポジトリです。

## ディレクトリ構成

- `src/solver`: Rust 実装（状態生成、後退解析、SQLite 出力）
- `src/web`: TypeScript/HTML アプリ + Cloudflare Pages Functions

## ローカルで動かす

1. Web アプリのディレクトリに移動します。

```bash
cd src/web
```

2. 依存関係をインストールします。

```bash
npm install
```

3. ローカルサーバーを起動します。

```bash
npm run pages:dev
```

## Cloudflare へのデプロイ手順

1. Web アプリのディレクトリに移動します。

```bash
cd src/web
```

2. 依存関係をインストールし、ビルドします。

```bash
npm install
npm run build
```

3. 本番用の Wrangler 設定を作成します（Git 管理外）。

```bash
cp wrangler.private.example.toml wrangler.private.toml
```

4. `wrangler.private.toml` の `database_id` を実際の D1 Database ID に変更します。

```toml
database_id = "YOUR_REAL_D1_DATABASE_ID"
```

5. Cloudflare Pages へデプロイします。

```bash
npm run pages:deploy
```

`pages:deploy` 実行時は、事前に `wrangler.private.toml` の検証が行われ、`database_id=local` など無効な値の場合は停止します。

- `src/solver/README.md`: 解析用 Rust 側の手順
- `src/web/README.md`: Web 側の詳細手順
