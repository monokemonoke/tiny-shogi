#!/usr/bin/env python3
"""
ローカルDBからスプリント用局面をサンプリングしてJSONに保存する。
条件: 先手視点でWin(N>=50)、両王が盤上に存在。
出力: src/web/public/sprint_positions.json
"""

import sqlite3
import json
import random
import os

DB_PATH = os.path.join(os.path.dirname(__file__), '../../solver/data/lookup.db')
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), '../public/sprint_positions.json')
SAMPLE_COUNT = 200
MIN_N = 50


def decode_hash(hex_str: str):
    val = int(hex_str, 16)
    board = []
    for y in range(4):
        row = []
        for x in range(4):
            nibble = (val >> ((y * 4 + x) * 4)) & 0xF
            if nibble >= 8:
                nibble -= 16
            row.append(int(nibble))
        board.append(row)
    sente_kin  = int((val >> 64) & 0xF)
    sente_kaku = int((val >> 68) & 0xF)
    gote_kin   = int((val >> 72) & 0xF)
    gote_kaku  = int((val >> 76) & 0xF)
    is_sente   = int((val >> 80) & 0x1)
    return board, sente_kin, sente_kaku, gote_kin, gote_kaku, is_sente


def flip_position(board, sk, sbk, gk, gbk, is_sente):
    """180°回転 + 駒の正負反転 + 持駒と手番のスワップ"""
    new_board = [[0] * 4 for _ in range(4)]
    for y in range(4):
        for x in range(4):
            new_board[3 - y][3 - x] = -board[y][x]
    return new_board, gk, gbk, sk, sbk, 1 - is_sente


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Win局面のみ大量取得してフィルタリング
    cur.execute(
        "SELECT hash, value FROM results WHERE value LIKE '%Win%' ORDER BY RANDOM() LIMIT 500000"
    )
    rows = cur.fetchall()
    conn.close()

    candidates = []
    for hash_str, val_str in rows:
        try:
            obj = json.loads(val_str)
            n = obj.get('Win')
            if n is None or n < MIN_N:
                continue
            board, sk, sbk, gk, gbk, is_sente = decode_hash(hash_str)
            # 先手視点に変換（DBはほぼすべて is_sente=0 で保存）
            board, sk, sbk, gk, gbk, is_sente = flip_position(board, sk, sbk, gk, gbk, is_sente)
            # 両王の存在確認
            flat = [c for row in board for c in row]
            if 1 not in flat or -1 not in flat:
                continue
            candidates.append({
                'board': board,
                'sente_kin': sk,
                'sente_kaku': sbk,
                'gote_kin': gk,
                'gote_kaku': gbk,
            })
        except Exception:
            continue

    print(f"候補局面数: {len(candidates)}")

    sampled = random.sample(candidates, min(SAMPLE_COUNT, len(candidates)))
    print(f"サンプル数: {len(sampled)}")

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(sampled, f, ensure_ascii=False)

    print(f"保存完了: {OUTPUT_PATH}")


if __name__ == '__main__':
    main()
