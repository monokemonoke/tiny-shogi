# Solver (Rust)

This directory contains the Rust implementation for:

- state generation
- retrograde analysis
- SQLite export for lookup DB

## Setup

```bash
cargo build
```

## Precompute and Export

```bash
cargo run --release -- all
cargo run --release -- export_sqlite
```

The exported DB is created at:

```
data/lookup.db
```
