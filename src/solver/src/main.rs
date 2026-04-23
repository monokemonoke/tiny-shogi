use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fmt;
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use tiny_http::{Header, Response, Server};

const BOARD_SIZE: usize = 4;
const PIECE_KING: i8 = 1;
const PIECE_GOLD: i8 = 2;
const PIECE_BISHOP: i8 = 3;
const PIECE_HORSE: i8 = 4;

#[derive(Clone, Serialize, Deserialize)]
struct State {
    is_sente: bool,
    board: [[i8; BOARD_SIZE]; BOARD_SIZE],
    sente: [i8; 2],
    gote: [i8; 2],
}

impl fmt::Display for State {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let to_char = |n: i8| match n {
            0 => " .",
            PIECE_KING => "+O",              // 王
            PIECE_GOLD => "+G",              // 金
            PIECE_BISHOP => "+K",            // 角
            PIECE_HORSE => "+U",             // 馬
            _ if n == -PIECE_KING => "-O",   // 王
            _ if n == -PIECE_GOLD => "-G",   // 金
            _ if n == -PIECE_BISHOP => "-K", // 角
            _ if n == -PIECE_HORSE => "-U",  // 馬
            _ => " ?",
        };

        write!(f, "Gote : G{}, K{}\n", self.gote[0], self.gote[1])?;
        write!(f, "   0  1  2  3\n")?;
        for (y, row) in self.board.iter().enumerate() {
            write!(f, "{} ", y)?;
            for &cell in row {
                write!(f, "{} ", to_char(cell))?;
            }
            writeln!(f)?;
        }
        write!(f, "Sente: G{}, K{}\n", self.sente[0], self.sente[1])?;
        Ok(())
    }
}

impl State {
    fn init() -> Self {
        State {
            is_sente: true,
            board: [
                [0, -PIECE_BISHOP, -PIECE_GOLD, -PIECE_KING],
                [0; BOARD_SIZE],
                [0; BOARD_SIZE],
                [PIECE_KING, PIECE_GOLD, PIECE_BISHOP, 0],
            ],
            sente: [0, 0],
            gote: [0, 0],
        }
    }

    fn to_u128(&self) -> u128 {
        let hash1 = self.encode_hash();
        let hash2 = self.encode_hash_flipped();
        hash1.min(hash2)
    }

    fn encode_hash(&self) -> u128 {
        let mut hash: u128 = 0;

        for y in 0..BOARD_SIZE {
            for x in 0..BOARD_SIZE {
                let piece = (self.board[y][x] as u128 & 0xF) << ((y * BOARD_SIZE + x) * 4);
                hash |= piece;
            }
        }

        hash |= (self.sente[0] as u128 & 0xF) << 64;
        hash |= (self.sente[1] as u128 & 0xF) << 68;
        hash |= (self.gote[0] as u128 & 0xF) << 72;
        hash |= (self.gote[1] as u128 & 0xF) << 76;
        hash |= (self.is_sente as u128) << 80;

        hash
    }

    fn encode_hash_flipped(&self) -> u128 {
        let mut hash: u128 = 0;

        // 盤面を180度回転 & 駒の符号を反転
        for y in 0..BOARD_SIZE {
            for x in 0..BOARD_SIZE {
                let flipped_y = (BOARD_SIZE - 1) - y;
                let flipped_x = (BOARD_SIZE - 1) - x;
                let piece =
                    (-self.board[y][x] as u128 & 0xF) << ((flipped_y * BOARD_SIZE + flipped_x) * 4);
                hash |= piece;
            }
        }

        // 持ち駒を入れ替え（先手↔後手）
        hash |= (self.gote[0] as u128 & 0xF) << 64;
        hash |= (self.gote[1] as u128 & 0xF) << 68;
        hash |= (self.sente[0] as u128 & 0xF) << 72;
        hash |= (self.sente[1] as u128 & 0xF) << 76;
        hash |= (!self.is_sente as u128) << 80;

        hash
    }

    fn next(&self) -> Vec<State> {
        let mut next_states = Vec::new();

        for y in 0..BOARD_SIZE {
            for x in 0..BOARD_SIZE {
                let piece = self.board[y][x];
                if piece == 0 || !Self::belongs_to_player(piece, self.is_sente) {
                    continue;
                }

                match piece.abs() {
                    PIECE_KING => self.generate_king_moves(&mut next_states, x, y),
                    PIECE_GOLD => self.generate_gold_moves(&mut next_states, x, y),
                    PIECE_BISHOP => self.generate_bishop_moves(&mut next_states, x, y),
                    PIECE_HORSE => self.generate_horse_moves(&mut next_states, x, y),
                    _ => {}
                }
            }
        }

        self.generate_drop_moves(&mut next_states);

        // 王手放置の手を除外
        next_states.retain(|state| !state.is_king_captured(!state.is_sente));

        next_states
    }

    fn is_king_captured(&self, player_is_sente: bool) -> bool {
        // プレイヤーの王の位置を探す
        let king_piece = if player_is_sente {
            PIECE_KING
        } else {
            -PIECE_KING
        };
        let mut king_pos: Option<(usize, usize)> = None;

        for y in 0..BOARD_SIZE {
            for x in 0..BOARD_SIZE {
                if self.board[y][x] == king_piece {
                    king_pos = Some((x, y));
                    break;
                }
            }
            if king_pos.is_some() {
                break;
            }
        }

        // 王が見つからない場合はありえないのでパニック
        let (king_x, king_y) = match king_pos {
            Some(pos) => pos,
            None => panic!(
                "King not found for player: {}",
                if player_is_sente { "Sente" } else { "Gote" }
            ),
        };

        // 相手の駒が王を取れるかチェック
        for y in 0..BOARD_SIZE {
            for x in 0..BOARD_SIZE {
                let piece = self.board[y][x];
                if piece == 0 || !Self::belongs_to_player(piece, !player_is_sente) {
                    continue;
                }

                if self.can_attack(x, y, king_x, king_y, piece.abs()) {
                    return true;
                }
            }
        }

        false
    }

    fn can_attack(
        &self,
        from_x: usize,
        from_y: usize,
        to_x: usize,
        to_y: usize,
        piece_abs: i8,
    ) -> bool {
        match piece_abs {
            PIECE_KING => self.can_king_attack(from_x, from_y, to_x, to_y),
            PIECE_GOLD => self.can_gold_attack(from_x, from_y, to_x, to_y),
            PIECE_BISHOP | PIECE_HORSE => {
                self.can_diagonal_attack(from_x, from_y, to_x, to_y, piece_abs)
            }
            _ => false,
        }
    }

    fn can_king_attack(&self, from_x: usize, from_y: usize, to_x: usize, to_y: usize) -> bool {
        let dx = (to_x as i32 - from_x as i32).abs();
        let dy = (to_y as i32 - from_y as i32).abs();
        dx <= 1 && dy <= 1 && (dx != 0 || dy != 0)
    }

    fn can_gold_attack(&self, from_x: usize, from_y: usize, to_x: usize, to_y: usize) -> bool {
        let dx = to_x as i32 - from_x as i32;
        let dy = to_y as i32 - from_y as i32;

        // 金の動きを判定（駒の所有者に基づいて調整）
        let piece = self.board[from_y][from_x];
        let is_sente = piece > 0;
        let adjusted_dy = if is_sente { dy } else { -dy };

        const GOLD_DELTAS: [(i32, i32); 6] = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (0, 1)];
        GOLD_DELTAS
            .iter()
            .any(|&(gdx, gdy)| gdx == dx && gdy == adjusted_dy)
    }

    fn can_diagonal_attack(
        &self,
        from_x: usize,
        from_y: usize,
        to_x: usize,
        to_y: usize,
        piece_abs: i8,
    ) -> bool {
        let dx = to_x as i32 - from_x as i32;
        let dy = to_y as i32 - from_y as i32;

        // 馬の場合は直交方向も可能
        if piece_abs == PIECE_HORSE {
            if dx == 0 || dy == 0 {
                // 直交方向（1マスのみ）
                return (dx.abs() == 1 && dy == 0) || (dx == 0 && dy.abs() == 1);
            }
        }

        // 斜め方向
        if dx.abs() != dy.abs() {
            return false;
        }

        // 経路上に駒があるかチェック
        let step_x = dx.signum();
        let step_y = dy.signum();
        let mut current_x = from_x as i32 + step_x;
        let mut current_y = from_y as i32 + step_y;

        while current_x != to_x as i32 || current_y != to_y as i32 {
            if self.board[current_y as usize][current_x as usize] != 0 {
                return false;
            }
            current_x += step_x;
            current_y += step_y;
        }

        true
    }

    fn generate_king_moves(&self, next_states: &mut Vec<State>, x: usize, y: usize) {
        const KING_DELTAS: [(i32, i32); 8] = [
            (-1, -1),
            (0, -1),
            (1, -1),
            (-1, 0),
            (1, 0),
            (-1, 1),
            (0, 1),
            (1, 1),
        ];

        for &(dx, dy) in &KING_DELTAS {
            if let Some((nx, ny)) = Self::apply_offset(x, y, dx, dy) {
                let target = self.board[ny][nx];
                if Self::belongs_to_player(target, self.is_sente) {
                    continue;
                }
                self.push_move(next_states, x, y, nx, ny, PIECE_KING);
            }
        }
    }

    fn generate_gold_moves(&self, next_states: &mut Vec<State>, x: usize, y: usize) {
        const GOLD_DELTAS: [(i32, i32); 6] = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (0, 1)];

        for &(dx, dy) in &GOLD_DELTAS {
            let adjusted_dy = if self.is_sente { dy } else { -dy };
            if let Some((nx, ny)) = Self::apply_offset(x, y, dx, adjusted_dy) {
                let target = self.board[ny][nx];
                if Self::belongs_to_player(target, self.is_sente) {
                    continue;
                }
                self.push_move(next_states, x, y, nx, ny, PIECE_GOLD);
            }
        }
    }

    fn generate_bishop_moves(&self, next_states: &mut Vec<State>, x: usize, y: usize) {
        self.generate_diagonal_moves(next_states, x, y, PIECE_BISHOP, true);
    }

    fn generate_horse_moves(&self, next_states: &mut Vec<State>, x: usize, y: usize) {
        self.generate_diagonal_moves(next_states, x, y, PIECE_HORSE, false);
        const ORTHOGONAL_DELTAS: [(i32, i32); 4] = [(0, -1), (0, 1), (-1, 0), (1, 0)];

        for &(dx, dy) in &ORTHOGONAL_DELTAS {
            if let Some((nx, ny)) = Self::apply_offset(x, y, dx, dy) {
                let target = self.board[ny][nx];
                if Self::belongs_to_player(target, self.is_sente) {
                    continue;
                }
                self.push_move(next_states, x, y, nx, ny, PIECE_HORSE);
            }
        }
    }

    fn generate_diagonal_moves(
        &self,
        next_states: &mut Vec<State>,
        x: usize,
        y: usize,
        piece_abs: i8,
        allow_promotion: bool,
    ) {
        const DIAGONAL_DELTAS: [(i32, i32); 4] = [(-1, -1), (-1, 1), (1, -1), (1, 1)];

        for &(dx, dy) in &DIAGONAL_DELTAS {
            let mut distance = 1;
            while let Some((nx, ny)) = Self::apply_offset(x, y, dx * distance, dy * distance) {
                let target = self.board[ny][nx];
                if Self::belongs_to_player(target, self.is_sente) {
                    break;
                }

                self.push_move(next_states, x, y, nx, ny, piece_abs);

                if allow_promotion
                    && piece_abs == PIECE_BISHOP
                    && Self::can_promote_bishop(y, ny, self.is_sente)
                {
                    self.push_move(next_states, x, y, nx, ny, PIECE_HORSE);
                }

                if target != 0 {
                    break;
                }
                distance += 1;
            }
        }
    }

    fn generate_drop_moves(&self, next_states: &mut Vec<State>) {
        const HAND_PIECES: [(usize, i8); 2] = [(0, PIECE_GOLD), (1, PIECE_BISHOP)];

        for &(hand_index, piece_abs) in &HAND_PIECES {
            let count = if self.is_sente {
                self.sente[hand_index]
            } else {
                self.gote[hand_index]
            };

            if count <= 0 {
                continue;
            }

            for y in 0..BOARD_SIZE {
                for x in 0..BOARD_SIZE {
                    if self.board[y][x] != 0 {
                        continue;
                    }

                    let mut next = self.clone();
                    if self.is_sente {
                        next.sente[hand_index] -= 1;
                    } else {
                        next.gote[hand_index] -= 1;
                    }

                    next.board[y][x] = if self.is_sente { piece_abs } else { -piece_abs };
                    next.is_sente = !self.is_sente;
                    next_states.push(next);
                }
            }
        }
    }

    fn push_move(
        &self,
        next_states: &mut Vec<State>,
        from_x: usize,
        from_y: usize,
        to_x: usize,
        to_y: usize,
        piece_abs: i8,
    ) {
        let mut next = self.clone();
        let target = next.board[to_y][to_x];
        if target != 0 {
            let (gold, bishop) = Self::captured_counts(target);
            if self.is_sente {
                next.sente[0] += gold;
                next.sente[1] += bishop;
            } else {
                next.gote[0] += gold;
                next.gote[1] += bishop;
            }
        }

        next.board[from_y][from_x] = 0;
        next.board[to_y][to_x] = if self.is_sente { piece_abs } else { -piece_abs };
        next.is_sente = !self.is_sente;
        next_states.push(next);
    }

    fn belongs_to_player(piece: i8, is_sente: bool) -> bool {
        piece != 0 && (piece > 0) == is_sente
    }

    fn captured_counts(piece: i8) -> (i8, i8) {
        match piece.abs() {
            PIECE_GOLD => (1, 0),
            PIECE_BISHOP | PIECE_HORSE => (0, 1),
            _ => (0, 0),
        }
    }

    fn can_promote_bishop(from_y: usize, to_y: usize, is_sente: bool) -> bool {
        Self::in_promotion_zone(from_y, is_sente) || Self::in_promotion_zone(to_y, is_sente)
    }

    fn in_promotion_zone(row: usize, is_sente: bool) -> bool {
        if is_sente {
            row == 0
        } else {
            row == BOARD_SIZE - 1
        }
    }

    fn apply_offset(x: usize, y: usize, dx: i32, dy: i32) -> Option<(usize, usize)> {
        let nx = x as i32 + dx;
        let ny = y as i32 + dy;
        if (0..BOARD_SIZE as i32).contains(&nx) && (0..BOARD_SIZE as i32).contains(&ny) {
            Some((nx as usize, ny as usize))
        } else {
            None
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mode = if args.len() > 1 {
        args[1].as_str()
    } else {
        "help"
    };

    match mode {
        "generate" => {
            println!("=== Mode: Generate All States ===\n");
            let all_states = generate_all_states();
            save_states(&all_states);
        }
        "analyze" => {
            println!("=== Mode: Retrograde Analysis ===\n");
            println!("Loading states from 'states.bin'...");
            match load_states() {
                Ok(all_states) => {
                    println!("Loaded {} states\n", all_states.len());
                    println!("=== Starting Retrograde Analysis ===\n");
                    retrograde_analysis(&all_states);
                }
                Err(e) => {
                    eprintln!("Error loading states: {}", e);
                    eprintln!("Please run 'generate' mode first to create the state file.");
                    std::process::exit(1);
                }
            }
        }
        "all" => {
            println!("=== Mode: Generate + Analyze ===\n");
            let all_states = generate_all_states();
            save_states(&all_states);
            println!("\n=== Starting Retrograde Analysis ===\n");
            retrograde_analysis(&all_states);
        }
        "play" => {
            println!("=== Mode: Interactive Play ===\n");
            play_game(true);
        }
        "pv" => {
            println!("=== Mode: Show Principal Variation ===\n");
            show_pv();
        }
        "interactive" => {
            println!("=== Mode: Interactive Analysis ===\n");
            start_interactive_analysis();
        }
        "server" => {
            println!("=== Mode: Analysis Server ===\n");
            start_server();
        }
        "dump" => {
            dump_winning_strategy();
        }
        "count" => {
            count_winning_states();
        }
        "count_gote" => {
            count_winning_states_gote();
        }
        "dump_gote" => {
            dump_winning_strategy_gote();
        }
        "find_bishop_nonpromotion_best" => {
            find_bishop_nonpromotion_best();
        }
        "find_first_bishop_nonpromotion_best" => {
            find_first_bishop_nonpromotion_best();
        }
        "export_json" => {
            println!("=== Mode: Export to JSON Buckets ===\n");
            export_to_json_buckets();
        }
        "export_sqlite" => {
            println!("=== Mode: Export to SQLite ===\n");
            let batch_size = if args.len() > 2 {
                args[2].parse::<usize>().unwrap_or(1000)
            } else {
                1000
            };
            export_to_sqlite(batch_size);
        }
        _ => {
            eprintln!(
                "Usage: {} [generate|analyze|all|play|pv|interactive|server|find_bishop_nonpromotion_best|find_first_bishop_nonpromotion_best|export_json|export_sqlite]",
                args[0]
            );
            eprintln!("  generate:      Generate all states and save to files");
            eprintln!("  analyze:       Load states and perform retrograde analysis");
            eprintln!("  all:           Do both generation and analysis");
            eprintln!("  play:          Play against computer");
            eprintln!("  pv:            Show optimal move sequence");
            eprintln!("  interactive:   Manually explore game tree with evaluations");
            eprintln!("  server:        Start analysis API server for GUI");
            eprintln!("  find_bishop_nonpromotion_best: Find states where bishop non-promotion is best but promotion is not");
            eprintln!("  find_first_bishop_nonpromotion_best: Find the first state where bishop non-promotion is best but promotion is not");
            eprintln!("  export_json:   Export analysis results to JSON buckets");
            eprintln!("  export_sqlite: Export analysis results to SQLite database [batch_size]");
            std::process::exit(1);
        }
    }
}

fn start_interactive_analysis() {
    println!("Loading analysis results...");
    let file =
        File::open("data/analysis_results.bin").expect("Failed to open data/analysis_results.bin");
    let reader = BufReader::new(file);
    let results: HashMap<u128, GameResult> =
        bincode::deserialize_from(reader).expect("Failed to deserialize results");
    println!("Loaded results.\n");

    let mut state = State::init();
    let mut history: Vec<State> = Vec::new();

    loop {
        println!("\n==================================");
        println!("{}", state);
        println!("Hash: {:032X}", state.to_u128());

        let current_res = results
            .get(&state.to_u128())
            .unwrap_or(&GameResult::Unknown);
        println!(
            "Current Evaluation: {:?} (for current turn player)",
            current_res
        );
        println!("Turn: {}", if state.is_sente { "Sente" } else { "Gote" });

        let next_moves = state.next();
        if next_moves.is_empty() {
            println!("No legal moves. Terminal state.");
        } else {
            println!("\nLegal Moves & Evaluations:");
            for (i, next_state) in next_moves.iter().enumerate() {
                let res = results
                    .get(&next_state.to_u128())
                    .unwrap_or(&GameResult::Unknown);
                let move_str = detect_move_str(&state, next_state);
                println!(
                    "{}: [{}] {:?} -> Leads to {:?}",
                    i,
                    move_str,
                    next_state.to_u128(),
                    res
                );
            }
        }

        println!(
            "\nCommands: [0-{}] select move, 'b' back, 'q' quit",
            next_moves.len().saturating_sub(1)
        );
        print!("> ");
        std::io::stdout().flush().unwrap();

        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
        let input = input.trim();

        if input == "q" {
            break;
        } else if input == "b" {
            if let Some(prev) = history.pop() {
                state = prev;
            } else {
                println!("Cannot go back, at initial state.");
            }
        } else if let Ok(idx) = input.parse::<usize>() {
            if idx < next_moves.len() {
                history.push(state.clone());
                state = next_moves[idx].clone();
            } else {
                println!("Invalid index.");
            }
        } else {
            println!("Invalid command.");
        }
    }
}

fn play_game(vs_computer: bool) {
    let mut results: HashMap<u128, GameResult> = HashMap::new();

    if vs_computer {
        println!("Loading analysis results...");
        if let Ok(file) = File::open("data/analysis_results.bin") {
            let reader = BufReader::new(file);
            if let Ok(res) = bincode::deserialize_from(reader) {
                results = res;
                println!("Loaded results for {} states.\n", results.len());
            } else {
                println!("Failed to deserialize results. Playing without hints.");
            }
        } else {
            println!("Analysis file not found. Playing without hints.");
        }
    }

    let mut state = State::init();

    loop {
        println!("\n==================================");
        println!("{}", state);
        println!("Hash: {:032X}", state.to_u128());

        let next_moves = state.next();
        if next_moves.is_empty() {
            println!("\nNo legal moves. Game Over!");
            println!("Winner: {}", if state.is_sente { "Gote" } else { "Sente" });
            break;
        }

        // 人間のターンかどうかの判定
        // vs_computer=trueのときは先手のみ人間
        // vs_computer=falseのときは常に人間
        let is_human_turn = !vs_computer || state.is_sente;

        if is_human_turn {
            state = process_human_turn(&state, &next_moves, &results, vs_computer);
        } else {
            state = process_computer_turn(&state, &next_moves, &results);
        }
    }
}

fn process_human_turn(
    state: &State,
    next_moves: &[State],
    results: &HashMap<u128, GameResult>,
    show_hints: bool,
) -> State {
    println!(
        "\nTurn: {} (Human)",
        if state.is_sente { "Sente" } else { "Gote" }
    );

    if show_hints {
        if let Some(res) = results.get(&state.to_u128()) {
            println!("Analysis: {:?}", res);
        }
    }

    println!("Enter move index to select next state:");
    println!("Legal Moves:");
    for (i, next_state) in next_moves.iter().enumerate() {
        // 簡易的に盤面全体を表示
        println!("--- Move {} ---", i);
        println!("{}", next_state);
    }

    println!("Select move index (0-{}): ", next_moves.len() - 1);

    loop {
        print!("> ");
        std::io::stdout().flush().unwrap();

        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
        let input = input.trim();

        if input == "quit" || input == "exit" {
            std::process::exit(0);
        }

        if let Ok(idx) = input.parse::<usize>() {
            if idx < next_moves.len() {
                return next_moves[idx].clone();
            } else {
                println!("Invalid index. Please enter 0-{}.", next_moves.len() - 1);
            }
        } else {
            println!("Invalid number. Please enter 0-{}.", next_moves.len() - 1);
        }
    }
}

fn process_computer_turn(
    _state: &State,
    next_moves: &[State],
    results: &HashMap<u128, GameResult>,
) -> State {
    println!("\nComputer Turn (Gote)...");

    let mut candidates: Vec<(&State, GameResult)> = Vec::new();

    for next_state in next_moves {
        let res = results
            .get(&next_state.to_u128())
            .unwrap_or(&GameResult::Unknown);
        candidates.push((next_state, *res));
    }

    // ソート
    candidates.sort_by(|a, b| {
        let score_a = score_for_gote(a.1);
        let score_b = score_for_gote(b.1);
        score_a.cmp(&score_b)
    });

    // 一番良い手を選択
    if let Some((best, res)) = candidates.first() {
        println!("Computer chose move leading to: {:?}", res);
        (*best).clone()
    } else {
        // next_movesが空でないことは呼び出し元で確認済みだが、念のため
        panic!("No moves available for computer!");
    }
}

#[allow(dead_code)]
fn trace_game() {
    println!("Loading analysis results...");
    let file =
        File::open("data/analysis_results.bin").expect("Failed to open data/analysis_results.bin");
    let reader = BufReader::new(file);
    let results: HashMap<u128, GameResult> =
        bincode::deserialize_from(reader).expect("Failed to deserialize results");
    println!("Loaded results for {} states.\n", results.len());

    let mut state = State::init();
    let mut history = Vec::new(); // ハッシュの履歴
    let mut history_states = Vec::new(); // 状態の履歴（表示用）

    println!("=== Starting Trace (Optimal Play vs Optimal Play) ===\n");

    let mut turn = 1;
    loop {
        let hash = state.to_u128();

        // 千日手検出
        if let Some(idx) = history.iter().position(|&h| h == hash) {
            println!("\n!!! LOOP DETECTED !!!");
            println!(
                "Current state matches state at turn {} (index {})",
                idx + 1,
                idx
            );
            println!("Loop length: {} moves", history.len() - idx);

            // ループ部分の手順を表示
            println!("\n=== Loop Sequence ===");
            for i in idx..history.len() {
                println!("Move {}:", i + 1);
                println!("{}", history_states[i]);
                println!("Hash: {:032X}\n", history[i]);
            }
            println!("Move {} (Back to Start of Loop):", history.len() + 1);
            println!("{}", state);
            break;
        }

        history.push(hash);
        history_states.push(state.clone());

        println!(
            "Turn {}: {}",
            turn,
            if state.is_sente { "Sente" } else { "Gote" }
        );
        println!("{}", state);

        let next_moves = state.next();
        if next_moves.is_empty() {
            println!(
                "Game Over! Winner: {}",
                if state.is_sente { "Gote" } else { "Sente" }
            );
            break;
        }

        // 最善手を選ぶ
        let mut candidates: Vec<(&State, GameResult)> = Vec::new();
        for next_state in &next_moves {
            let res = results
                .get(&next_state.to_u128())
                .unwrap_or(&GameResult::Unknown);
            candidates.push((next_state, *res));
        }

        // Debug: Show all candidates for Turn 1
        if turn == 1 {
            println!("DEBUG: All candidates for Turn 1:");
            for (i, (_s, res)) in candidates.iter().enumerate() {
                let score = score_for_gote(*res);
                println!("  Move {}: {:?} -> Score {:?}", i, res, score);
            }
        }

        // ソート（手番側にとって良い順 = score_for_gote と同じロジックでOK）
        // GameResult は「次の状態の結果」＝「相手の手番の結果」
        // 相手がLose(n) -> 自分Win(n) -> 優先
        // 相手がUnknown -> 自分Unknown
        // 相手がWin(n) -> 自分Lose(n) -> 後回し
        candidates.sort_by(|a, b| {
            let score_a = score_for_gote(a.1);
            let score_b = score_for_gote(b.1);
            score_a.cmp(&score_b)
        });

        if let Some((best, res)) = candidates.first() {
            println!("Best move leads to opponent: {:?}", res);
            state = (*best).clone();
        } else {
            break;
        }

        turn += 1;

        // 安全のため、ある程度で打ち切る
        if turn > 1000 {
            println!("Aborted: Trace too long > 1000 moves");
            break;
        }
    }
}

// 評価関数の代わり（並び替え用）
// 小さい方が良い
#[derive(PartialEq, Eq, PartialOrd, Ord, Debug)]
enum MoveScore {
    Win(u32),  // 相手がLose(n)。nが小さいほど良い（最短勝ち）
    Unknown,   // 相手がUnknown。
    Lose(u32), // 相手がWin(n)。nが大きいほど良い（最長負け）
}

fn score_for_gote(res: GameResult) -> MoveScore {
    match res {
        GameResult::Lose(n) => MoveScore::Win(n), // 相手が負ける＝自分が勝つ
        GameResult::Unknown => MoveScore::Unknown,
        GameResult::Win(n) => MoveScore::Lose(u32::MAX - n), // 相手が勝つ（nで）＝自分が負ける。nが大きいほうがマシ（MoveScoreとしては小さくしたいので反転）
                                                             // Win(1) -> Lose(MAX-1) (悪い)
                                                             // Win(100) -> Lose(MAX-100) (マシ) -> 小さい値になる
    }
}

// Assuming `State` struct is defined elsewhere and this is an `impl State` block.
// This placement is based on the user's instruction, which shows it before `generate_all_states`.

fn generate_all_states() -> Vec<State> {
    let state = State::init();
    println!("Initial State:\n{}", state);
    println!("State Hash: {:032X}\n", state.to_u128());

    let mut visited = HashSet::new();
    let mut queue = vec![state];
    let mut all_states = Vec::new();

    visited.insert(queue[0].to_u128());

    println!("Enumerating all states...");
    while let Some(current) = queue.pop() {
        all_states.push(current.clone());

        if all_states.len() % 1000000 == 0 {
            println!("Progress: {} states found", all_states.len());
        }

        for next_state in current.next() {
            let hash = next_state.to_u128();
            if visited.insert(hash) {
                queue.push(next_state);
            }
        }
    }

    println!("\nTotal unique states: {}", all_states.len());

    all_states
}

fn save_states(all_states: &[State]) {
    // 状態全体をバイナリファイルに保存
    println!("\nSaving states to 'data/states.bin'...");
    std::fs::create_dir_all("data").expect("Failed to create data directory");
    let file = File::create("data/states.bin").expect("Failed to create file");
    let writer = BufWriter::new(file);

    bincode::serialize_into(writer, all_states).expect("Failed to serialize states");

    let metadata = std::fs::metadata("data/states.bin").ok();
    let file_size_mb = metadata.map(|m| m.len() / 1_000_000).unwrap_or(0);
    println!("Saved {} states ({} MB)", all_states.len(), file_size_mb);

    // ハッシュ値もバイナリファイルに保存
    println!("Saving hash values to 'data/states_hash.bin'...");
    let hash_file = File::create("data/states_hash.bin").expect("Failed to create file");
    let mut hash_writer = BufWriter::new(hash_file);

    for state in all_states {
        let hash = state.to_u128();
        hash_writer
            .write_all(&hash.to_le_bytes())
            .expect("Failed to write");
    }
    hash_writer.flush().expect("Failed to flush");

    println!(
        "Saved {} hash values ({} MB)",
        all_states.len(),
        (all_states.len() * 16) / 1_000_000
    );

    // 状態数の統計情報も保存
    println!("\nSaving statistics to 'data/states_stats.txt'...");
    let mut stats_file =
        File::create("data/states_stats.txt").expect("Failed to create stats file");
    writeln!(stats_file, "Mini Shogi State Enumeration").expect("Failed to write");
    writeln!(stats_file, "============================").expect("Failed to write");
    writeln!(stats_file, "Total unique states: {}", all_states.len()).expect("Failed to write");
    writeln!(
        stats_file,
        "File size: {} bytes ({} MB)",
        all_states.len() * 16,
        (all_states.len() * 16) / 1_000_000
    )
    .expect("Failed to write");

    println!("Done saving files!");
}

fn load_states() -> Result<Vec<State>, Box<dyn std::error::Error>> {
    let file = File::open("data/states.bin")?;
    let reader = BufReader::new(file);
    let states: Vec<State> = bincode::deserialize_from(reader)?;
    Ok(states)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum GameResult {
    Unknown,
    Win(u32),  // n手で勝ち
    Lose(u32), // n手で負け
}

fn retrograde_analysis(all_states: &[State]) {
    // 1. ハッシュからインデックスへのマップ作成
    println!("Building state index map...");
    let mut state_to_index = HashMap::with_capacity(all_states.len());
    for (i, state) in all_states.iter().enumerate() {
        state_to_index.insert(state.to_u128(), i);
    }

    // 2. 隣接リストの作成（遷移の事前計算）
    println!("Pre-calculating state transitions (Adjacency List)...");
    let mut adj_list: Vec<Vec<usize>> = Vec::with_capacity(all_states.len());
    let mut results: Vec<GameResult> = vec![GameResult::Unknown; all_states.len()];
    let mut initial_lose_count = 0;

    for (i, state) in all_states.iter().enumerate() {
        let next_moves = state.next();
        if next_moves.is_empty() {
            results[i] = GameResult::Lose(0); // 次の手がない = 負け (Checkmate)
            initial_lose_count += 1;
            adj_list.push(Vec::new());
        } else {
            let mut indices = Vec::with_capacity(next_moves.len());
            for next_state in next_moves {
                if let Some(&idx) = state_to_index.get(&next_state.to_u128()) {
                    indices.push(idx);
                } else {
                    // 理論上ここには来ないはず
                    eprintln!(
                        "Warning: State not found in index map: {:032X}",
                        next_state.to_u128()
                    );
                }
            }
            adj_list.push(indices);
        }

        if i % 500000 == 0 && i > 0 {
            println!("  Processed {}/{}", i, all_states.len());
        }
    }

    println!("Found {} terminal states (checkmate)", initial_lose_count);

    // 3. 反復解析
    println!("Performing retrograde analysis (using adjacency list)...\n");
    let mut iteration = 0;
    let mut changed = true;

    while changed {
        iteration += 1;
        let (resolved, is_changed) = perform_analysis_iteration(&adj_list, &mut results);
        changed = is_changed;

        log_progress(iteration, resolved, all_states.len(), &results);
    }

    println!(
        "\nRetrograde analysis completed after {} iterations",
        iteration
    );

    // HashMap形式に変換して保存
    println!("Converting results to HashMap for saving...");
    let mut results_map = HashMap::with_capacity(all_states.len());
    for (i, res) in results.iter().enumerate() {
        results_map.insert(all_states[i].to_u128(), *res);
    }
    save_analysis_results(all_states, &results_map);
}

fn perform_analysis_iteration(
    adj_list: &[Vec<usize>],
    results: &mut Vec<GameResult>,
) -> (usize, bool) {
    let mut resolved_this_iteration = 0;
    let mut changed = false;

    for i in 0..results.len() {
        if results[i] != GameResult::Unknown {
            continue;
        }

        let next_indices = &adj_list[i];

        let mut reached_lose = false;
        let mut min_opponent_lose_moves = u32::MAX;
        let mut all_leads_to_win = true;
        let mut max_opponent_win_moves = 0;

        for &next_idx in next_indices {
            match results[next_idx] {
                GameResult::Lose(n) => {
                    reached_lose = true;
                    min_opponent_lose_moves = min_opponent_lose_moves.min(n);
                    all_leads_to_win = false;
                }
                GameResult::Win(n) => {
                    max_opponent_win_moves = max_opponent_win_moves.max(n);
                }
                GameResult::Unknown => {
                    all_leads_to_win = false;
                }
            }
        }

        if reached_lose {
            results[i] = GameResult::Win(min_opponent_lose_moves + 1);
            changed = true;
            resolved_this_iteration += 1;
        } else if all_leads_to_win {
            results[i] = GameResult::Lose(max_opponent_win_moves + 1);
            changed = true;
            resolved_this_iteration += 1;
        }
    }
    (resolved_this_iteration, changed)
}

fn log_progress(iteration: i32, resolved: usize, total_states: usize, results: &[GameResult]) {
    let solved_count = results
        .iter()
        .filter(|&&r| r != GameResult::Unknown)
        .count();
    let unknown_count = total_states - solved_count;
    println!(
        "Iteration {}: Resolved {} states | Total solved: {}/{} ({:.2}%) | Remaining: {}",
        iteration,
        resolved,
        solved_count,
        total_states,
        (solved_count as f64 / total_states as f64) * 100.0,
        unknown_count
    );
}

fn save_analysis_results(all_states: &[State], results: &HashMap<u128, GameResult>) {
    let mut win_count = 0;
    let mut lose_count = 0;
    let mut unknown_count = 0;

    for result in results.values() {
        match result {
            GameResult::Win(_) => win_count += 1,
            GameResult::Lose(_) => lose_count += 1,
            GameResult::Unknown => unknown_count += 1,
        }
    }

    println!("\n=== Analysis Results ===");
    let total = all_states.len();
    println!(
        "Win states:     {} ({:.2}%)",
        win_count,
        win_count as f64 / total as f64 * 100.0
    );
    println!(
        "Lose states:    {} ({:.2}%)",
        lose_count,
        lose_count as f64 / total as f64 * 100.0
    );
    println!(
        "Unknown states: {} ({:.2}%)",
        unknown_count,
        unknown_count as f64 / total as f64 * 100.0
    );

    save_summary_txt(total, win_count, lose_count, unknown_count);

    println!("Saving detailed analysis results to 'data/analysis_results.bin'...");
    let file = File::create("data/analysis_results.bin").expect("Failed to create file");
    let writer = BufWriter::new(file);
    bincode::serialize_into(writer, &results).expect("Failed to serialize results");
    println!("Saved detailed results.");

    show_initial_state_result(all_states, results);
}

fn save_summary_txt(total: usize, win: usize, lose: usize, unknown: usize) {
    println!("\nSaving analysis summary to 'data/retrograde_results.txt'...");
    std::fs::create_dir_all("data").expect("Failed to create data directory");
    let mut file = File::create("data/retrograde_results.txt").expect("Failed to create file");
    writeln!(file, "Retrograde Analysis Results").unwrap();
    writeln!(file, "===========================").unwrap();
    writeln!(file, "Total states: {}", total).unwrap();
    writeln!(
        file,
        "Win states:   {} ({:.2}%)",
        win,
        win as f64 / total as f64 * 100.0
    )
    .unwrap();
    writeln!(
        file,
        "Lose states:  {} ({:.2}%)",
        lose,
        lose as f64 / total as f64 * 100.0
    )
    .unwrap();
    writeln!(
        file,
        "Unknown states: {} ({:.2}%)",
        unknown,
        unknown as f64 / total as f64 * 100.0
    )
    .unwrap();
}

fn show_initial_state_result(all_states: &[State], results: &HashMap<u128, GameResult>) {
    println!("\n=== Initial State Result ===");
    if let Some(initial_state) = all_states.first() {
        let initial_hash = initial_state.to_u128();
        match results.get(&initial_hash) {
            Some(GameResult::Win(n)) => println!("Initial State: WIN in {} moves (Best Move)", n),
            Some(GameResult::Lose(n)) => {
                println!("Initial State: LOSE in {} moves (Best Resistance)", n)
            }
            Some(GameResult::Unknown) => println!("Initial State: UNKNOWN (Draw/Cycle)"),
            None => println!("Initial State: Error (Result not found)"),
        }
    }
}

fn show_pv() {
    println!("Loading analysis results...");
    let file =
        File::open("data/analysis_results.bin").expect("Failed to open data/analysis_results.bin");
    let reader = BufReader::new(file);
    let results: HashMap<u128, GameResult> =
        bincode::deserialize_from(reader).expect("Failed to deserialize results");
    println!("Loaded results.\n");

    let mut state = State::init();
    let mut turn = 1;

    loop {
        println!(
            "\n=== Turn {} ({}) ===",
            turn,
            if state.is_sente { "Sente" } else { "Gote" }
        );
        println!("{}", state);
        let hash = state.to_u128();
        println!("Hash: {:032X}", hash);

        let res = results.get(&hash).unwrap_or(&GameResult::Unknown);
        println!("Result: {:?}", res);

        if let GameResult::Lose(_) = res {
            println!("Current player loses. Choosing best resistance...");
        }

        // 詰みなら終了
        let next_moves = state.next();
        if next_moves.is_empty() {
            println!("Checkmate!");
            break;
        }

        let target_res = match res {
            GameResult::Win(n) => GameResult::Lose(n - 1),
            GameResult::Lose(n) => GameResult::Win(n - 1),
            GameResult::Unknown => GameResult::Unknown,
        };

        if matches!(res, GameResult::Unknown) {
            println!("Unknown result. Stopping PV.");
            break;
        }

        let mut best_move = None;

        for next_state in &next_moves {
            let next_res = results
                .get(&next_state.to_u128())
                .unwrap_or(&GameResult::Unknown);
            if *next_res == target_res {
                best_move = Some(next_state.clone());
                break;
            }
        }

        if let Some(bm) = best_move {
            state = bm;
            turn += 1;
        } else {
            println!(
                "Error: Could not find move leading to {:?}. Debugging...",
                target_res
            );
            println!("Available moves:");
            for next_state in &next_moves {
                let r = results
                    .get(&next_state.to_u128())
                    .unwrap_or(&GameResult::Unknown);
                println!("-> {:?}", r);
            }
            break;
        }
    }
}

#[derive(Serialize)]
struct AnalyzeResponse {
    current_evaluation: GameResult,
    turn: String,
    hash: String, // Added hash field
    next_moves: Vec<MoveInfo>,
}

#[derive(Serialize)]
struct MoveInfo {
    index: usize,
    move_str: String,
    result: GameResult,
    hash: String,
}

fn start_server() {
    let results = load_analysis_results_safely();
    println!("Loaded results. Starting server on localhost:8080...");

    let server = Server::http("127.0.0.1:8080").unwrap();

    for request in server.incoming_requests() {
        handle_client(request, &results);
    }
}

fn load_analysis_results_safely() -> HashMap<u128, GameResult> {
    println!("Loading analysis results...");
    match File::open("data/analysis_results.bin") {
        Ok(file) => {
            let reader = BufReader::new(file);
            bincode::deserialize_from(reader).unwrap_or_else(|_| {
                println!("Warning: Failed to deserialize results. Starting with empty knowledge.");
                HashMap::new()
            })
        }
        Err(_) => {
            println!(
                "Warning: 'data/analysis_results.bin' not found. Starting with empty knowledge."
            );
            HashMap::new()
        }
    }
}

fn handle_client(request: tiny_http::Request, results: &HashMap<u128, GameResult>) {
    let url = request.url().to_string();
    if url == "/analyze" && request.method() == &tiny_http::Method::Post {
        handle_analyze_request(request, results);
    } else {
        serve_static_file(request, &url);
    }
}

fn handle_analyze_request(mut request: tiny_http::Request, results: &HashMap<u128, GameResult>) {
    let mut content = String::new();
    if request.as_reader().read_to_string(&mut content).is_err() {
        let _ = request.respond(Response::from_string("Error reading body").with_status_code(400));
        return;
    }

    match serde_json::from_str::<State>(&content) {
        Ok(state) => {
            let current_hash = state.to_u128();
            let current_res = results
                .get(&current_hash)
                .cloned()
                .unwrap_or(GameResult::Unknown);

            println!(
                "Analyze Request: Hash={:032X} Eval={:?}",
                current_hash, current_res
            );

            let mut next_moves_info = Vec::new();
            let next_states = state.next();

            for (i, next_state) in next_states.iter().enumerate() {
                let res = results
                    .get(&next_state.to_u128())
                    .cloned()
                    .unwrap_or(GameResult::Unknown);
                let move_str = detect_move_str(&state, next_state);
                next_moves_info.push(MoveInfo {
                    index: i,
                    move_str,
                    result: res,
                    hash: format!("{:032X}", next_state.to_u128()),
                });
            }

            let response_data = AnalyzeResponse {
                current_evaluation: current_res,
                turn: if state.is_sente {
                    "Sente".to_string()
                } else {
                    "Gote".to_string()
                },
                hash: format!("{:032X}", current_hash),
                next_moves: next_moves_info,
            };

            let json = serde_json::to_string(&response_data).unwrap();
            let header =
                Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
            let response = Response::from_string(json).with_header(header);
            let _ = request.respond(response);
        }
        Err(e) => {
            let response =
                Response::from_string(format!("Error parsing JSON: {}", e)).with_status_code(400);
            let _ = request.respond(response);
        }
    }
}

fn serve_static_file(request: tiny_http::Request, url: &str) {
    if url.contains("..") {
        let response = Response::from_string("403 Forbidden").with_status_code(403);
        let _ = request.respond(response);
        return;
    }

    let path = if url == "/" { "/index.html" } else { url };

    // Remove leading slash to make it relative
    let relative_path = path.trim_start_matches('/');
    let fs_path = format!("./{}", relative_path);

    // Verify it is a file and exists
    if let Ok(file) = File::open(&fs_path) {
        // Additional check: Ensure fs_path is actually inside current directory
        // (Though strictly canonicalizing might be better, rejecting ".." covers most cases for this simple server)

        let content_type = get_content_type(&fs_path);
        let header = Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap();
        let response = Response::from_file(file).with_header(header);
        let _ = request.respond(response);
    } else {
        let response = Response::from_string("404 Not Found").with_status_code(404);
        let _ = request.respond(response);
    }
}

fn get_content_type(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html"
    } else if path.ends_with(".js") {
        "application/javascript"
    } else if path.ends_with(".css") {
        "text/css"
    } else if path.ends_with(".mp3") {
        "audio/mpeg"
    } else {
        "text/plain"
    }
}

fn detect_move_str(current: &State, next: &State) -> String {
    // Check for drop
    let pieces = ["金", "角"];
    for i in 0..2 {
        if current.is_sente {
            if current.sente[i] > next.sente[i] {
                // Drop detected
                for y in 0..BOARD_SIZE {
                    for x in 0..BOARD_SIZE {
                        if current.board[y][x] == 0 && next.board[y][x] != 0 {
                            return format!("{}{}{}\u{6253}", x, y, pieces[i]); // xy金打
                        }
                    }
                }
            }
        } else {
            if current.gote[i] > next.gote[i] {
                // Drop detected
                for y in 0..BOARD_SIZE {
                    for x in 0..BOARD_SIZE {
                        if current.board[y][x] == 0 && next.board[y][x] != 0 {
                            return format!("{}{}{}\u{6253}", x, y, pieces[i]); // xy金打
                        }
                    }
                }
            }
        }
    }

    // Board move
    let mut from_pos = None;
    let mut to_pos = None;

    for y in 0..BOARD_SIZE {
        for x in 0..BOARD_SIZE {
            let c = current.board[y][x];
            let n = next.board[y][x];
            if c != n {
                if n == 0 {
                    from_pos = Some((x, y));
                } else if c != 0 && n != 0 {
                    to_pos = Some((x, y));
                } else if c == 0 && n != 0 {
                    to_pos = Some((x, y));
                }
            }
        }
    }

    match (from_pos, to_pos) {
        (Some((fx, fy)), Some((tx, ty))) => {
            let piece_name = match next.board[ty][tx].abs() {
                PIECE_KING => "王",
                PIECE_GOLD => "金",
                PIECE_BISHOP => "角",
                PIECE_HORSE => "馬",
                _ => "?",
            };
            let promote = if current.board[fy][fx].abs() == PIECE_BISHOP
                && next.board[ty][tx].abs() == PIECE_HORSE
            {
                "成"
            } else {
                ""
            };
            format!("{}{}{}{}({}{})", tx, ty, piece_name, promote, fx, fy) // 12王(01) or 12馬成(01)
        }
        _ => "不明".to_string(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct BishopPromotionKey {
    from_x: usize,
    from_y: usize,
    to_x: usize,
    to_y: usize,
}

struct BishopPromotionPair {
    key: BishopPromotionKey,
    non_promotion: State,
    promotion: State,
}

struct BishopPromotionFinding {
    current: State,
    current_result: GameResult,
    pair: BishopPromotionPair,
    non_promotion_result: GameResult,
    promotion_result: GameResult,
}

fn find_bishop_nonpromotion_best() {
    find_bishop_nonpromotion_best_inner(false);
}

fn find_first_bishop_nonpromotion_best() {
    find_bishop_nonpromotion_best_inner(true);
}

fn find_bishop_nonpromotion_best_inner(stop_at_first: bool) {
    println!("Loading lookup database...");
    let conn = Connection::open("data/lookup.db").expect("Failed to open data/lookup.db");
    conn.execute_batch(
        "
        PRAGMA query_only = ON;
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -200000;
    ",
    )
    .expect("Failed to configure SQLite");
    let mut stmt = conn
        .prepare("SELECT value FROM results WHERE hash = ?1")
        .expect("Failed to prepare lookup query");

    println!("Streaming states from 'data/states.bin'...");
    let file = File::open("data/states.bin").expect("Failed to open data/states.bin");
    let mut reader = BufReader::new(file);
    let total_states: u64 =
        bincode::deserialize_from(&mut reader).expect("Failed to read state count");
    println!("Total states: {}", total_states);

    let started_at = std::time::Instant::now();
    let mut candidate_state_count = 0_u64;
    let mut candidate_pair_count = 0_u64;
    let mut matched_state_count = 0_u64;
    let mut matched_pair_count = 0_u64;
    let mut first_finding: Option<BishopPromotionFinding> = None;

    for index in 0..total_states {
        let state: State =
            bincode::deserialize_from(&mut reader).expect("Failed to read a state entry");
        let promotion_pairs = collect_bishop_promotion_pairs(&state);

        if !promotion_pairs.is_empty() {
            candidate_state_count += 1;
            let current_result = lookup_game_result(&mut stmt, state.to_u128());
            let mut matched_in_state = false;

            for pair in promotion_pairs {
                candidate_pair_count += 1;

                let non_promotion_result =
                    lookup_game_result(&mut stmt, pair.non_promotion.to_u128());
                let promotion_result = lookup_game_result(&mut stmt, pair.promotion.to_u128());

                if is_best_child_result(current_result, non_promotion_result)
                    && !is_best_child_result(current_result, promotion_result)
                {
                    matched_pair_count += 1;
                    matched_in_state = true;

                    if first_finding.is_none() {
                        first_finding = Some(BishopPromotionFinding {
                            current: state.clone(),
                            current_result,
                            pair,
                            non_promotion_result,
                            promotion_result,
                        });

                        if stop_at_first {
                            println!(
                                "\nFound a matching state after scanning {} states in {:.1}s",
                                index + 1,
                                started_at.elapsed().as_secs_f64()
                            );
                            print_bishop_promotion_finding(first_finding.as_ref().unwrap());
                            return;
                        }
                    }
                }
            }

            if matched_in_state {
                matched_state_count += 1;
            }
        }

        let processed = index + 1;
        if processed % 1_000_000 == 0 {
            println!(
                "Processed {:>8}/{:>8} | candidate states: {:>8} | matches: {:>8} | elapsed: {:.1}s",
                processed,
                total_states,
                candidate_state_count,
                matched_state_count,
                started_at.elapsed().as_secs_f64()
            );
        }
    }

    println!("\nScan completed in {:.1}s", started_at.elapsed().as_secs_f64());
    println!("States with a promotion choice: {}", candidate_state_count);
    println!("Promotion-choice move pairs: {}", candidate_pair_count);
    println!(
        "States where bishop non-promotion is best and promotion is not: {}",
        matched_state_count
    );
    println!(
        "Move pairs where bishop non-promotion is best and promotion is not: {}",
        matched_pair_count
    );

    match first_finding {
        Some(finding) => print_bishop_promotion_finding(&finding),
        None => println!("\nNo matching state found."),
    }
}

fn collect_bishop_promotion_pairs(state: &State) -> Vec<BishopPromotionPair> {
    let mut grouped: HashMap<BishopPromotionKey, (Option<State>, Option<State>)> = HashMap::new();

    for next_state in state.next() {
        let Some((key, promote)) = extract_bishop_promotion_key(state, &next_state) else {
            continue;
        };

        let entry = grouped.entry(key).or_insert((None, None));
        if promote {
            entry.1 = Some(next_state);
        } else {
            entry.0 = Some(next_state);
        }
    }

    grouped
        .into_iter()
        .filter_map(|(key, (non_promotion, promotion))| match (non_promotion, promotion) {
            (Some(non_promotion), Some(promotion)) => Some(BishopPromotionPair {
                key,
                non_promotion,
                promotion,
            }),
            _ => None,
        })
        .collect()
}

fn extract_bishop_promotion_key(
    current: &State,
    next: &State,
) -> Option<(BishopPromotionKey, bool)> {
    let move_data = extract_move_data(current, next);
    let (from_x, from_y) = (move_data.from_x?, move_data.from_y?);

    if current.board[from_y][from_x].abs() != PIECE_BISHOP {
        return None;
    }

    Some((
        BishopPromotionKey {
            from_x,
            from_y,
            to_x: move_data.to_x,
            to_y: move_data.to_y,
        },
        move_data.promote,
    ))
}

fn lookup_game_result(stmt: &mut rusqlite::Statement<'_>, hash: u128) -> GameResult {
    let hash_str = format!("{:032X}", hash);
    let value: String = stmt
        .query_row(params![hash_str], |row| row.get(0))
        .expect("Result not found in SQLite lookup");
    parse_game_result(&value)
}

fn parse_game_result(value: &str) -> GameResult {
    if value == "\"Unknown\"" {
        return GameResult::Unknown;
    }

    if let Some(text) = value
        .strip_prefix("{\"Win\":")
        .and_then(|s| s.strip_suffix('}'))
    {
        return GameResult::Win(text.parse().expect("Invalid Win value"));
    }

    if let Some(text) = value
        .strip_prefix("{\"Lose\":")
        .and_then(|s| s.strip_suffix('}'))
    {
        return GameResult::Lose(text.parse().expect("Invalid Lose value"));
    }

    panic!("Unknown GameResult JSON: {}", value);
}

fn is_best_child_result(current_result: GameResult, child_result: GameResult) -> bool {
    match current_result {
        GameResult::Win(n) => n
            .checked_sub(1)
            .map(|moves| child_result == GameResult::Lose(moves))
            .unwrap_or(false),
        GameResult::Lose(n) => n
            .checked_sub(1)
            .map(|moves| child_result == GameResult::Win(moves))
            .unwrap_or(false),
        GameResult::Unknown => child_result == GameResult::Unknown,
    }
}

fn print_bishop_promotion_finding(finding: &BishopPromotionFinding) {
    println!("\n=== First Matching State ===");
    println!("Current hash: {:032X}", finding.current.to_u128());
    println!("Current result: {:?}", finding.current_result);
    println!("Turn: {}", if finding.current.is_sente { "Sente" } else { "Gote" });
    println!(
        "Move: ({}{}, {}{})",
        finding.pair.key.from_x,
        finding.pair.key.from_y,
        finding.pair.key.to_x,
        finding.pair.key.to_y
    );
    println!("\n{}", finding.current);

    println!(
        "Non-promotion: {} -> {:?}",
        detect_move_str(&finding.current, &finding.pair.non_promotion),
        finding.non_promotion_result
    );
    println!("Hash: {:032X}", finding.pair.non_promotion.to_u128());
    println!("{}", finding.pair.non_promotion);

    println!(
        "Promotion: {} -> {:?}",
        detect_move_str(&finding.current, &finding.pair.promotion),
        finding.promotion_result
    );
    println!("Hash: {:032X}", finding.pair.promotion.to_u128());
    println!("{}", finding.pair.promotion);
}

fn count_winning_states() {
    println!("Loading analysis results...");
    let file =
        File::open("data/analysis_results.bin").expect("Failed to open data/analysis_results.bin");
    let reader = BufReader::new(file);
    let results: HashMap<u128, GameResult> =
        bincode::deserialize_from(reader).expect("Failed to deserialize results");
    println!("Loaded results for {} states.", results.len());

    let state = State::init();
    let mut visited = HashSet::new();
    let mut queue = Vec::new();

    if visited.insert(state.to_u128()) {
        queue.push(state);
    }

    println!("Counting necessary states...");
    while let Some(current) = queue.pop() {
        let next_moves = current.next();

        // Find best move
        let mut best_move: Option<State> = None;
        let mut min_moves = u32::MAX;

        for next_state in next_moves {
            // current is Sente. next_state is Gote's turn.
            // We want result for Gote to be Lose(n) (Sente wins in n)
            let res = results
                .get(&next_state.to_u128())
                .unwrap_or(&GameResult::Unknown);
            if let GameResult::Lose(n) = res {
                if *n < min_moves {
                    min_moves = *n;
                    best_move = Some(next_state);
                }
            }
        }

        if let Some(gote_state) = best_move {
            // Gote's turn: Consider ALL legal moves
            let gote_moves = gote_state.next();
            for gote_next in gote_moves {
                // gote_next is Sente's turn
                if visited.insert(gote_next.to_u128()) {
                    queue.push(gote_next);
                }
            }
        }
    }

    println!("Total states to store: {}", visited.len());
}

fn count_winning_states_gote() {
    println!("Loading analysis results for Gote...");
    let file =
        File::open("data/analysis_results.bin").expect("Failed to open data/analysis_results.bin");
    let reader = BufReader::new(file);
    let results: HashMap<u128, GameResult> =
        bincode::deserialize_from(reader).expect("Failed to deserialize results");
    println!("Loaded results for {} states.", results.len());

    let root = State::init();
    let mut visited_sente_states = HashSet::new();
    let mut queue = Vec::new();

    if visited_sente_states.insert(root.to_u128()) {
        queue.push(root);
    }

    let mut gote_winning_states = HashSet::new();

    println!("Traversing for Gote Winning States...");
    while let Some(current_sente_state) = queue.pop() {
        let sente_moves = current_sente_state.next();

        for gote_turn_state in sente_moves {
            // Check if Gote can win from here.
            let res = results
                .get(&gote_turn_state.to_u128())
                .unwrap_or(&GameResult::Unknown);

            if let GameResult::Win(_n) = res {
                // Yes, Gote can force a win!
                if gote_winning_states.insert(gote_turn_state.to_u128()) {
                    // Find Gote's best move
                    let mut best_move: Option<State> = None;
                    let mut min_moves = u32::MAX;

                    let gote_moves = gote_turn_state.next();
                    for m in gote_moves {
                        let m_res = results.get(&m.to_u128()).unwrap_or(&GameResult::Unknown);
                        if let GameResult::Lose(k) = m_res {
                            if *k < min_moves {
                                min_moves = *k;
                                best_move = Some(m);
                            }
                        }
                    }

                    if let Some(next_sente_state) = best_move {
                        if visited_sente_states.insert(next_sente_state.to_u128()) {
                            queue.push(next_sente_state);
                        }
                    }
                }
            }
        }
    }

    println!(
        "Total Gote winning states to store: {}",
        gote_winning_states.len()
    );
}

#[derive(Serialize)]
struct MoveData {
    from_x: Option<usize>, // None if drop
    from_y: Option<usize>,
    to_x: usize,
    to_y: usize,
    drop_piece: Option<i8>, // None if board move
    promote: bool,
}

fn dump_winning_strategy() {
    eprintln!("Loading analysis results...");
    let file =
        File::open("data/analysis_results.bin").expect("Failed to open data/analysis_results.bin");
    let reader = BufReader::new(file);
    let results: HashMap<u128, GameResult> =
        bincode::deserialize_from(reader).expect("Failed to deserialize results");
    eprintln!("Loaded results for {} states.", results.len());

    let state = State::init();
    let mut visited = HashSet::new();
    let mut queue = Vec::new();
    let mut strategy_map: HashMap<String, MoveData> = HashMap::new();

    if visited.insert(state.to_u128()) {
        queue.push(state);
    }

    eprintln!("Generating strategy data...");
    while let Some(current) = queue.pop() {
        let current_hash = format!("{:032X}", current.to_u128());
        let next_moves = current.next();

        let mut best_move: Option<State> = None;
        let mut min_moves = u32::MAX;

        if !current.is_sente {
            panic!("Queue should only contain Sente states");
        }

        for next_state in &next_moves {
            let res = results
                .get(&next_state.to_u128())
                .unwrap_or(&GameResult::Unknown);
            if let GameResult::Lose(n) = res {
                if *n < min_moves {
                    min_moves = *n;
                    best_move = Some(next_state.clone());
                }
            }
        }

        if let Some(gote_state) = best_move {
            let move_data = extract_move_data(&current, &gote_state);
            strategy_map.insert(current_hash, move_data);

            let gote_moves = gote_state.next();
            for gote_next in gote_moves {
                if visited.insert(gote_next.to_u128()) {
                    queue.push(gote_next);
                }
            }
        }
    }

    eprintln!("Strategy contains {} moves.", strategy_map.len());

    let json = serde_json::to_string_pretty(&strategy_map).expect("Failed to serialize strategy");
    println!("const AI_STRATEGY = {};", json);
}

fn extract_move_data(current: &State, next: &State) -> MoveData {
    // Check for drop
    let pieces_indices = [(0, PIECE_GOLD), (1, PIECE_BISHOP)];

    // Check drops based on who is moving
    for (i, piece_val) in pieces_indices {
        let (curr_hand_count, next_hand_count) = if current.is_sente {
            (current.sente[i], next.sente[i])
        } else {
            (current.gote[i], next.gote[i])
        };

        if curr_hand_count > next_hand_count {
            // Drop detected
            for y in 0..BOARD_SIZE {
                for x in 0..BOARD_SIZE {
                    if current.board[y][x] == 0 && next.board[y][x] != 0 {
                        return MoveData {
                            from_x: None,
                            from_y: None,
                            to_x: x,
                            to_y: y,
                            drop_piece: Some(piece_val),
                            promote: false,
                        };
                    }
                }
            }
        }
    }

    // Board move
    let mut from_pos = None;
    let mut to_pos = None;
    for y in 0..BOARD_SIZE {
        for x in 0..BOARD_SIZE {
            let c = current.board[y][x];
            let n = next.board[y][x];
            if c != n {
                if n == 0 {
                    from_pos = Some((x, y));
                } else if c != 0 && n != 0 {
                    to_pos = Some((x, y));
                } else if c == 0 && n != 0 {
                    to_pos = Some((x, y));
                }
            }
        }
    }
    if let (Some((fx, fy)), Some((tx, ty))) = (from_pos, to_pos) {
        let promote =
            current.board[fy][fx].abs() == PIECE_BISHOP && next.board[ty][tx].abs() == PIECE_HORSE;
        return MoveData {
            from_x: Some(fx),
            from_y: Some(fy),
            to_x: tx,
            to_y: ty,
            drop_piece: None,
            promote,
        };
    }
    panic!("Could not detect move");
}

fn dump_winning_strategy_gote() {
    eprintln!("Loading analysis results (Gote)...");
    let file =
        File::open("data/analysis_results.bin").expect("Failed to open data/analysis_results.bin");
    let reader = BufReader::new(file);
    let results: HashMap<u128, GameResult> =
        bincode::deserialize_from(reader).expect("Failed to deserialize results");
    eprintln!("Loaded results for {} states.", results.len());

    let root = State::init();

    // We need to traverse:
    // Sente (Human) -> can play ANY move. So we explore ALL branches.
    // Gote (AI)    -> plays BEST move. We explore ONLY the best branch.

    let mut visited = HashSet::new();
    let mut queue = Vec::new();
    let mut strategy_map: HashMap<String, MoveData> = HashMap::new();

    // Start with Root (Sente turn)
    if visited.insert(root.to_u128()) {
        queue.push(root);
    }

    eprintln!("Generating Gote strategy data (Full Coverage)...");

    while let Some(state) = queue.pop() {
        if state.is_sente {
            // Human turn: Enqueue ALL children
            let moves = state.next();
            for next_state in moves {
                if visited.insert(next_state.to_u128()) {
                    queue.push(next_state);
                }
            }
        } else {
            // Gote (AI) turn: Find Best Move
            let moves = state.next();
            if moves.is_empty() {
                continue;
            }

            let mut best_move: Option<State> = None;
            let mut best_res: Option<GameResult> = None;

            for m in &moves {
                let res = results.get(&m.to_u128()).unwrap_or(&GameResult::Unknown);

                if best_res.is_none() {
                    best_res = Some(res.clone());
                    best_move = Some(m.clone());
                    continue;
                }

                let curr = best_res.as_ref().unwrap();

                // Compare `res` vs `curr` (both Sente perspectives)
                // We pick `res` if it is worse for Sente (better for Gote).
                let replace = match (res, curr) {
                    (GameResult::Lose(n1), GameResult::Lose(n2)) => n1 < n2, // Sente loses faster -> Gote wins faster -> Better
                    (GameResult::Lose(_), _) => true,
                    (_, GameResult::Lose(_)) => false,

                    (GameResult::Unknown, GameResult::Unknown) => false,
                    (GameResult::Unknown, GameResult::Win(_)) => true,
                    (GameResult::Win(_), GameResult::Unknown) => false,

                    (GameResult::Win(n1), GameResult::Win(n2)) => n1 > n2, // Sente wins slower -> Gote prolongs defeat -> Better
                };

                if replace {
                    best_res = Some(res.clone());
                    best_move = Some(m.clone());
                }
            }

            if let Some(target) = best_move {
                let move_data = extract_move_data(&state, &target);
                let hash_str = format!("{:032X}", state.to_u128());
                strategy_map.insert(hash_str, move_data);

                // For the AI's chosen path, we simulate that this is the "Main Line".
                if visited.insert(target.to_u128()) {
                    queue.push(target);
                }
            }
        }
    }

    eprintln!("Strategy contains {} moves.", strategy_map.len());
    let json = serde_json::to_string(&strategy_map).expect("Failed to serialize strategy");
    println!("const AI_STRATEGY = {};", json);
}

fn export_to_json_buckets() {
    println!("Loading analysis results from 'data/analysis_results.bin'...");
    let file =
        File::open("data/analysis_results.bin").expect("Failed to open data/analysis_results.bin");
    let reader = BufReader::new(file);
    let results: HashMap<u128, GameResult> =
        bincode::deserialize_from(reader).expect("Failed to deserialize results");
    println!("Loaded {} states\n", results.len());

    // Create output directory
    std::fs::create_dir_all("data/lookup").expect("Failed to create data/lookup directory");

    // Group by first 3 hex digits of hash (4096 buckets)
    let mut buckets: Vec<HashMap<String, GameResult>> = vec![HashMap::new(); 4096];

    println!("Grouping states into 4096 buckets...");
    for (hash, result) in results.iter() {
        let hash_str = format!("{:032X}", hash);
        let bucket_idx = u16::from_str_radix(&hash_str[0..3], 16).unwrap() as usize;
        buckets[bucket_idx].insert(hash_str, *result);
    }

    println!("Writing JSON files...");
    for (i, bucket) in buckets.iter().enumerate() {
        if bucket.is_empty() {
            continue;
        }

        let filename = format!("data/lookup/{:03x}.json", i);
        let file = File::create(&filename).expect(&format!("Failed to create {}", filename));
        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, bucket).expect(&format!("Failed to write {}", filename));

        if i % 256 == 0 {
            println!("  Written {}/4096 buckets...", i);
        }
    }

    println!("\nExport complete!");
    println!("Total buckets: 4096");
    println!("Output directory: data/lookup/");

    // Calculate total size
    let total_size: u64 = std::fs::read_dir("data/lookup")
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum();

    println!("\nTotal size: {} MB", total_size / 1_000_000);
}

fn export_to_sqlite(batch_size: usize) {
    use std::time::Instant;

    println!("Loading analysis results from 'data/analysis_results.bin'...");
    let file =
        File::open("data/analysis_results.bin").expect("Failed to open data/analysis_results.bin");
    let reader = BufReader::new(file);
    let results: HashMap<u128, GameResult> =
        bincode::deserialize_from(reader).expect("Failed to deserialize results");
    println!("Loaded {} states\n", results.len());

    // Create output directory
    std::fs::create_dir_all("data").expect("Failed to create data directory");

    // Create SQLite database
    let db_path = "data/lookup.db";
    println!("Creating SQLite database at '{}'...", db_path);

    // Remove existing database if present
    let _ = std::fs::remove_file(db_path);

    let conn = Connection::open(db_path).expect("Failed to create database");

    // Performance optimization PRAGMAs (for bulk insert only)
    conn.execute_batch(
        "
        PRAGMA synchronous = OFF;
        PRAGMA journal_mode = MEMORY;
        PRAGMA cache_size = -2000000;
        PRAGMA locking_mode = EXCLUSIVE;
        PRAGMA temp_store = MEMORY;
    ",
    )
    .expect("Failed to set PRAGMAs");

    // Create table (without PRIMARY KEY for faster bulk insert)
    conn.execute("CREATE TABLE results (hash TEXT, value TEXT)", [])
        .expect("Failed to create table");

    println!("Inserting all {} records...", results.len());
    println!(
        "Batch size: {} (commit every {} records)",
        batch_size, batch_size
    );
    println!("Optimization: Using prepared statement with batch commits\n");

    let total_records = results.len();
    let mut count = 0;
    let mut last_milestone = 0;
    let start_time = Instant::now();
    let mut milestone_time = start_time;

    // Prepare statement once (reuse for all inserts)
    let mut stmt = conn
        .prepare("INSERT INTO results (hash, value) VALUES (?, ?)")
        .expect("Failed to prepare statement");

    conn.execute("BEGIN TRANSACTION", [])
        .expect("Failed to begin transaction");

    for (hash, result) in results.iter() {
        let hash_str = format!("{:032X}", hash);
        let value_str = serde_json::to_string(result).expect("Failed to serialize result");

        stmt.execute(params![hash_str, value_str])
            .expect("Failed to execute insert");
        count += 1;

        // Commit and restart transaction every batch_size records
        if count % batch_size == 0 {
            conn.execute("COMMIT", []).expect("Failed to commit");
            conn.execute("BEGIN TRANSACTION", [])
                .expect("Failed to begin transaction");

            // Report every 1M records
            if count / 1_000_000 > last_milestone {
                let elapsed = milestone_time.elapsed();
                let progress = (count as f64 / total_records as f64) * 100.0;
                println!(
                    "  {:8} records ({:5.1}%) | +{:6.2}s | Total: {:6.2}s",
                    count,
                    progress,
                    elapsed.as_secs_f64(),
                    start_time.elapsed().as_secs_f64()
                );
                last_milestone = count / 1_000_000;
                milestone_time = Instant::now();
            }
        }
    }

    conn.execute("COMMIT", [])
        .expect("Failed to commit transaction");

    println!("Creating unique index on hash...");
    conn.execute("CREATE UNIQUE INDEX idx_results_hash ON results(hash)", [])
        .expect("Failed to create unique index");

    let total_time = start_time.elapsed();
    println!("\nExport complete!");
    println!("Total records inserted: {}", count);
    println!(
        "Total time: {:.2}s ({:.1} min)",
        total_time.as_secs_f64(),
        total_time.as_secs_f64() / 60.0
    );
    println!(
        "Average speed: {:.0} records/sec",
        count as f64 / total_time.as_secs_f64()
    );
    println!("Output file: {}", db_path);

    // Calculate file size
    if let Ok(metadata) = std::fs::metadata(db_path) {
        println!(
            "Database size: {} MB ({:.2} GB)",
            metadata.len() / 1_000_000,
            metadata.len() as f64 / 1_000_000_000.0
        );
    }
}
