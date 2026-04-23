# 「角不成」が最善手になる局面のメモ

## 問い

Tiny 将棋の全局面の中に、**「角不成」が最善手で、「角成」は最善手ではない**局面が存在するか。

## 結論

存在する。

少なくとも 1 局面は確認できた。代表例は次の局面。

```text
Gote : G0, K0
   0  1  2  3
0 +U  .  .  . 
1 +K  .  . -O 
2 +G  .  . -G 
3 +O  .  .  . 
Sente: G0, K0
```

- 手番: 先手
- 現局面の評価: `Win(7)`
- `10角(01)` -> `Lose(6)`
- `10馬成(01)` -> `Lose(8)`

この実装では `Win(n)` の局面では、遷移先が `Lose(n-1)` になる手が最善手になる。  
したがってこの局面では、`10角(01)` は最善手で、`10馬成(01)` は勝てる手ではあるが最善ではない。

## 確認方法

Rust ソルバーに確認用モードを追加して検証した。

```bash
cd src/solver
cargo run --release -- find_first_bishop_nonpromotion_best
```

このコマンドで、最初の該当局面が 2039 局面目で見つかった。

## 関連コード

- `src/solver/src/main.rs`
  - `find_bishop_nonpromotion_best`
  - `find_first_bishop_nonpromotion_best`
