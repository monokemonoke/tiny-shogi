# Web アプリ（TypeScript + HTML + Cloudflare Pages Functions）

このディレクトリには、Web アプリ本体と API Function が含まれています。

## インストールとビルド

```bash
npm install
npm run build
```

## ローカル開発（D1 + Dev Server）

1. 先に `src/solver` で DB を生成します。

```bash
cd ../solver
cargo run --release -- all
cargo run --release -- export_sqlite
```

2. 生成した DB を Web 側ワークスペースへコピーします。

```bash
mkdir -p data
cp ../solver/data/lookup.db data/lookup.db
```

3. ローカル D1 を初期化して開発サーバーを起動します。

```bash
npm run db:setup
npm run pages:dev
```

## 本番デプロイ（Cloudflare Pages）

1. 本番用 Wrangler 設定ファイルを作成します。

```bash
cp wrangler.private.example.toml wrangler.private.toml
```

2. `wrangler.private.toml` の `database_id` を実際の D1 Database ID に変更します。

```toml
database_id = "YOUR_REAL_D1_DATABASE_ID"
```

3. ビルドしてデプロイします。

```bash
npm run build
npm run pages:deploy
```

## Google Analytics（デプロイ時のみ有効化）

GA の Measurement ID は `VITE_GA_MEASUREMENT_ID` で注入します。  
この値は Git 管理外のローカルファイルに置いてください。

1. サンプルから本番用ローカル環境変数ファイルを作成します。

```bash
cp .env.example .env.production.local
```

2. `.env.production.local` に Measurement ID を設定します。

```bash
VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

`npm run build`（production build）時のみ読み込まれるため、ローカル開発でファイルを作らなければ GA は埋め込まれません。

## 注意

- 公開エクスポートでは `public/assets/` 配下はプレースホルダ化されます。
- `pages:dev` は実行時に `wrangler.public.toml` を `wrangler.toml` に反映して起動します。
- `pages:deploy` は実行時に `wrangler.private.toml` を `wrangler.toml` に反映し、事前に `database_id` を検証します。
