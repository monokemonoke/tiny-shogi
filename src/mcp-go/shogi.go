package main

import (
	"fmt"
	"math/big"
	"strings"
)

const rows = 4
const cols = 4

var pieceNames = map[PieceType]string{
	OU:   "玉",
	KIN:  "金",
	KAKU: "角",
	UMA:  "馬",
}

type pieceDef struct {
	Name         string
	Moves        [][2]int
	Range        bool
	SlidingPart  [][2]int
}

var pieceDefs = map[PieceType]pieceDef{
	OU:  {Name: "王", Moves: [][2]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}, {1, 1}, {1, -1}, {-1, 1}, {-1, -1}}},
	KIN: {Name: "金", Moves: [][2]int{{0, -1}, {1, -1}, {-1, -1}, {1, 0}, {-1, 0}, {0, 1}}},
	KAKU: {Name: "角", Moves: [][2]int{{1, 1}, {1, -1}, {-1, 1}, {-1, -1}}, Range: true},
	UMA: {
		Name:        "馬",
		Moves:       [][2]int{{1, 1}, {1, -1}, {-1, 1}, {-1, -1}, {0, 1}, {0, -1}, {1, 0}, {-1, 0}},
		Range:       true,
		SlidingPart: [][2]int{{1, 1}, {1, -1}, {-1, 1}, {-1, -1}},
	},
}

func opponent(player Player) Player {
	if player == Sente {
		return Gote
	}
	return Sente
}

func createInitialState() GameState {
	state := GameState{
		Hands: Hands{Sente: []PieceType{}, Gote: []PieceType{}},
		Turn:  Sente,
	}
	state.Board[0][1] = &Piece{Type: KAKU, Owner: Gote, Promoted: false}
	state.Board[0][2] = &Piece{Type: KIN, Owner: Gote, Promoted: false}
	state.Board[0][3] = &Piece{Type: OU, Owner: Gote, Promoted: false}
	state.Board[3][0] = &Piece{Type: OU, Owner: Sente, Promoted: false}
	state.Board[3][1] = &Piece{Type: KIN, Owner: Sente, Promoted: false}
	state.Board[3][2] = &Piece{Type: KAKU, Owner: Sente, Promoted: false}
	return state
}

func cloneState(state GameState) GameState {
	copied := GameState{
		Hands: Hands{
			Sente: make([]PieceType, len(state.Hands.Sente)),
			Gote:  make([]PieceType, len(state.Hands.Gote)),
		},
		Turn: state.Turn,
	}
	copy(copied.Hands.Sente, state.Hands.Sente)
	copy(copied.Hands.Gote, state.Hands.Gote)
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			if state.Board[y][x] != nil {
				p := *state.Board[y][x]
				copied.Board[y][x] = &p
			}
		}
	}
	return copied
}

func movementType(piece *Piece) PieceType {
	if piece.Type == UMA || (piece.Type == KAKU && piece.Promoted) {
		return UMA
	}
	return piece.Type
}

func handPieceType(piece *Piece) PieceType {
	if movementType(piece) == UMA {
		return KAKU
	}
	return piece.Type
}

func coordToKifu(x, y int) string {
	return fmt.Sprintf("%d%d", 4-x, y+1)
}

func kifuToCoord(value string) (x, y int, err error) {
	if len(value) < 2 {
		return 0, 0, fmt.Errorf("座標が短すぎます: %s", value)
	}
	file := int(value[0] - '0')
	rank := int(value[1] - '0')
	if file < 1 || file > 4 || rank < 1 || rank > 4 {
		return 0, 0, fmt.Errorf("不正な座標です: %s", value)
	}
	return 4 - file, rank - 1, nil
}

func coordToJapanese(x, y int) string {
	files := []string{"１", "２", "３", "４"}
	ranks := []string{"一", "二", "三", "四"}
	return files[4-x-1] + ranks[y]
}

type selection interface {
	isBoard() bool
}

type boardSelection struct {
	x     int
	y     int
	piece *Piece
}

func (boardSelection) isBoard() bool { return true }

type handSelection struct {
	index int
	pKey  PieceType
	owner Player
}

func (handSelection) isBoard() bool { return false }

func isPseudoLegalMove(sel selection, targetX, targetY int, board Board) bool {
	if targetX < 0 || targetX >= cols || targetY < 0 || targetY >= rows {
		return false
	}

	switch s := sel.(type) {
	case boardSelection:
		piece := s.piece
		if board[targetY][targetX] != nil && board[targetY][targetX].Owner == piece.Owner {
			return false
		}
		def := pieceDefs[movementType(piece)]
		dx := targetX - s.x
		dy := targetY - s.y

		if def.Range {
			signX := sign(dx)
			signY := sign(dy)
			isSliding := false
			if def.SlidingPart != nil {
				for _, move := range def.SlidingPart {
					moveX := move[0]
					moveY := move[1]
					if piece.Owner == Gote {
						moveX = -moveX
						moveY = -moveY
					}
					if (moveX == 0 && dx != 0) || (moveY == 0 && dy != 0) {
						continue
					}
					if (moveX != 0 && dx%moveX != 0) || (moveY != 0 && dy%moveY != 0) {
						continue
					}
					var stepX, stepY float64
					if moveX != 0 {
						stepX = float64(dx) / float64(moveX)
					} else {
						stepX = 999
					}
					if moveY != 0 {
						stepY = float64(dy) / float64(moveY)
					} else {
						stepY = 999
					}
					if stepX == 999 && stepY > 0 {
						isSliding = true
						break
					}
					if stepY == 999 && stepX > 0 {
						isSliding = true
						break
					}
					if stepX == stepY && stepX > 0 {
						isSliding = true
						break
					}
				}
			} else if abs(dx) == abs(dy) && abs(dx) > 0 {
				isSliding = true
			}

			if isSliding {
				x := s.x + signX
				y := s.y + signY
				for x != targetX || y != targetY {
					if board[y][x] != nil {
						return false
					}
					x += signX
					y += signY
				}
				return true
			}
		}

		for _, move := range def.Moves {
			moveX := move[0]
			moveY := move[1]
			if piece.Owner == Gote {
				moveX = -moveX
				moveY = -moveY
			}
			if dx == moveX && dy == moveY {
				return true
			}
		}
		return false

	case handSelection:
		return board[targetY][targetX] == nil
	}
	return false
}

func isKingInCheck(board Board, targetOwner Player) bool {
	kingX, kingY := findKing(board, targetOwner)
	if kingX < 0 {
		return true
	}
	attacker := opponent(targetOwner)
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			piece := board[y][x]
			if piece == nil || piece.Owner != attacker {
				continue
			}
			if isPseudoLegalMove(boardSelection{x: x, y: y, piece: piece}, kingX, kingY, board) {
				return true
			}
		}
	}
	return false
}

func isLegalMove(sel selection, targetX, targetY int, owner Player, board Board) bool {
	if !isPseudoLegalMove(sel, targetX, targetY, board) {
		return false
	}
	simBoard := copyBoard(board)
	switch s := sel.(type) {
	case boardSelection:
		piece := simBoard[s.y][s.x]
		simBoard[s.y][s.x] = nil
		simBoard[targetY][targetX] = piece
	case handSelection:
		simBoard[targetY][targetX] = &Piece{Type: s.pKey, Owner: owner, Promoted: false}
	}
	return !isKingInCheck(simBoard, owner)
}

func canPromote(piece *Piece, fromY, toY int) bool {
	if piece.Type != KAKU || piece.Promoted {
		return false
	}
	return (piece.Owner == Sente && (fromY == 0 || toY == 0)) ||
		(piece.Owner == Gote && (fromY == 3 || toY == 3))
}

func applyMove(state GameState, sel selection, targetX, targetY int, promote bool) GameState {
	nextState := cloneState(state)
	turn := state.Turn
	nextState.Turn = opponent(turn)

	switch s := sel.(type) {
	case boardSelection:
		piece := &Piece{Type: s.piece.Type, Owner: s.piece.Owner, Promoted: s.piece.Promoted}
		if promote {
			piece.Promoted = true
		}
		nextState.Board[s.y][s.x] = nil
		if target := nextState.Board[targetY][targetX]; target != nil {
			nextState.Hands = addToHand(nextState.Hands, turn, handPieceType(target))
		}
		nextState.Board[targetY][targetX] = piece
	case handSelection:
		nextState.Board[targetY][targetX] = &Piece{Type: s.pKey, Owner: turn, Promoted: false}
		nextState.Hands = removeFromHand(nextState.Hands, turn, s.index)
	}
	return nextState
}

func applyMoveRecord(state GameState, record MoveRecord) (GameState, MoveRecord, string, error) {
	turn := state.Turn

	switch r := record.(type) {
	case BoardMoveRecord:
		if r.FromY < 0 || r.FromY >= rows || r.FromX < 0 || r.FromX >= cols {
			return state, nil, "", fmt.Errorf("移動元座標が範囲外です")
		}
		piece := state.Board[r.FromY][r.FromX]
		if piece == nil || piece.Owner != turn {
			return state, nil, "", fmt.Errorf("棋譜の移動元に手番側の駒がありません: %s", coordToKifu(r.FromX, r.FromY))
		}
		sel := boardSelection{x: r.FromX, y: r.FromY, piece: piece}
		if !isLegalMove(sel, r.ToX, r.ToY, turn, state.Board) {
			return state, nil, "", fmt.Errorf("不合法手です: %s%s", coordToKifu(r.FromX, r.FromY), coordToKifu(r.ToX, r.ToY))
		}
		if r.Promote && !canPromote(piece, r.FromY, r.ToY) {
			return state, nil, "", fmt.Errorf("成れない手です: %s%s+", coordToKifu(r.FromX, r.FromY), coordToKifu(r.ToX, r.ToY))
		}
		mt := movementType(piece)
		enriched := BoardMoveRecord{
			Type:    "board",
			FromX:   r.FromX,
			FromY:   r.FromY,
			ToX:     r.ToX,
			ToY:     r.ToY,
			Piece:   &mt,
			Promote: r.Promote,
		}
		newState := applyMove(state, sel, r.ToX, r.ToY, r.Promote)
		return newState, enriched, moveToJapanese(enriched, nil), nil

	case HandMoveRecord:
		handIndex := indexOfHand(state.Hands, turn, r.Piece)
		if handIndex < 0 {
			return state, nil, "", fmt.Errorf("持ち駒に%sがありません", pieceNames[r.Piece])
		}
		sel := handSelection{index: handIndex, pKey: r.Piece, owner: turn}
		if !isLegalMove(sel, r.ToX, r.ToY, turn, state.Board) {
			return state, nil, "", fmt.Errorf("不合法な打ち手です: %s%s", pieceNames[r.Piece], coordToKifu(r.ToX, r.ToY))
		}
		newState := applyMove(state, sel, r.ToX, r.ToY, false)
		return newState, r, moveToJapaneseHand(r), nil
	}
	return state, nil, "", fmt.Errorf("不明な手の種類です")
}

func generateNextStates(state GameState) []GeneratedMove {
	var moves []GeneratedMove
	turn := state.Turn

	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			piece := state.Board[y][x]
			if piece == nil || piece.Owner != turn {
				continue
			}
			for targetY := 0; targetY < rows; targetY++ {
				for targetX := 0; targetX < cols; targetX++ {
					sel := boardSelection{x: x, y: y, piece: piece}
					if !isLegalMove(sel, targetX, targetY, turn, state.Board) {
						continue
					}
mt := movementType(piece)
					recordWithPiece := BoardMoveRecord{
						Type:    "board",
						FromX:   x,
						FromY:   y,
						ToX:     targetX,
						ToY:     targetY,
						Piece:   &mt,
						Promote: false,
					}
					moves = append(moves, GeneratedMove{
						State:    applyMove(state, sel, targetX, targetY, false),
						Record:   recordWithPiece,
						Japanese: moveToJapanese(recordWithPiece, nil),
					})
					if canPromote(piece, y, targetY) {
						promotedRecord := BoardMoveRecord{
							Type:    "board",
							FromX:   x,
							FromY:   y,
							ToX:     targetX,
							ToY:     targetY,
							Piece:   &mt,
							Promote: true,
						}
						moves = append(moves, GeneratedMove{
							State:    applyMove(state, sel, targetX, targetY, true),
							Record:   promotedRecord,
							Japanese: moveToJapanese(promotedRecord, nil),
						})
					}
				}
			}
		}
	}

	seen := map[PieceType]bool{}
	for _, pt := range getHand(state.Hands, turn) {
		if seen[pt] {
			continue
		}
		seen[pt] = true
		for y := 0; y < rows; y++ {
			for x := 0; x < cols; x++ {
				index := indexOfHand(state.Hands, turn, pt)
				sel := handSelection{index: index, pKey: pt, owner: turn}
				if !isLegalMove(sel, x, y, turn, state.Board) {
					continue
				}
				record := HandMoveRecord{
					Type:    "hand",
					ToX:     x,
					ToY:     y,
					Piece:   pt,
					Promote: false,
				}
				moves = append(moves, GeneratedMove{
					State:    applyMove(state, sel, x, y, false),
					Record:   record,
					Japanese: moveToJapaneseHand(record),
				})
			}
		}
	}

	return moves
}

func moveToJapanese(record BoardMoveRecord, _ *MoveRecord) string {
	square := coordToJapanese(record.ToX, record.ToY)
	pieceName := pieceNames[OU]
	if record.Piece != nil {
		pieceName = pieceNames[*record.Piece]
	}
	promoteStr := ""
	if record.Promote {
		promoteStr = "成"
	}
	return fmt.Sprintf("%s%s%s", square, pieceName, promoteStr)
}

func moveToJapaneseHand(record HandMoveRecord) string {
	square := coordToJapanese(record.ToX, record.ToY)
	pieceName := pieceNames[record.Piece]
	return fmt.Sprintf("%s%s打", square, pieceName)
}

func stateToSFENLike(state GameState) string {
	var rowStrs []string
	for y := 0; y < rows; y++ {
		var text strings.Builder
		empty := 0
		for x := 0; x < cols; x++ {
			piece := state.Board[y][x]
			if piece == nil {
				empty++
				continue
			}
			if empty > 0 {
				text.WriteString(fmt.Sprintf("%d", empty))
				empty = 0
			}
			text.WriteString(pieceToSFEN(*piece))
		}
		if empty > 0 {
			text.WriteString(fmt.Sprintf("%d", empty))
		}
		rowStrs = append(rowStrs, text.String())
	}
	turnStr := "b"
	if state.Turn == Gote {
		turnStr = "w"
	}
	return fmt.Sprintf("%s %s %s", strings.Join(rowStrs, "/"), turnStr, handsToSFEN(state))
}

// HashCalc は局面のハッシュ計算を行う
var HashCalc = struct {
	CalcHash       func(GameState) *big.Int
	EncodeHash     func(GameState) *big.Int
	EncodeHashFlip func(GameState) *big.Int
	HashToString   func(*big.Int) string
}{
	CalcHash: func(state GameState) *big.Int {
		h1 := encodeHash(state)
		h2 := encodeHashFlipped(state)
		if h1.Cmp(h2) < 0 {
			return h1
		}
		return h2
	},
	EncodeHash:     func(state GameState) *big.Int { return encodeHash(state) },
	EncodeHashFlip: func(state GameState) *big.Int { return encodeHashFlipped(state) },
	HashToString: func(hash *big.Int) string {
		return fmt.Sprintf("%032X", hash)
	},
}

func encodeHash(state GameState) *big.Int {
	hash := big.NewInt(0)
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			piece := state.Board[y][x]
			value := 0
			if piece != nil {
				switch piece.Type {
				case OU:
					value = 1
				case KIN:
					value = 2
				case KAKU:
					value = 3
				}
				if movementType(piece) == UMA {
					value = 4
				}
				if piece.Owner == Gote {
					value = -value
				}
			}
			hash.Or(hash, new(big.Int).Lsh(big.NewInt(int64(value&0xF)), uint((y*4+x)*4)))
		}
	}

	computed := computeHashInternals(state, Sente)
	hash.Or(hash, computed)
	return hash
}

func computeHashInternals(state GameState, perspective Player) *big.Int {
	result := big.NewInt(0)
	senteGold := countHand(state.Hands.Sente, KIN)
	senteBishop := countHand(state.Hands.Sente, KAKU)
	goteGold := countHand(state.Hands.Gote, KIN)
	goteBishop := countHand(state.Hands.Gote, KAKU)

	var sgOffset, sbOffset, ggOffset, gbOffset, turnOffset uint
	if perspective == Sente {
		sgOffset = 64
		sbOffset = 68
		ggOffset = 72
		gbOffset = 76
		turnOffset = 80
		if state.Turn == Sente {
			result.SetBit(result, int(turnOffset), 1)
		}
	} else {
		sgOffset = 72
		sbOffset = 76
		ggOffset = 64
		gbOffset = 68
		turnOffset = 80
		if state.Turn == Gote {
			result.SetBit(result, int(turnOffset), 1)
		}
	}

	result.Or(result, new(big.Int).Lsh(big.NewInt(int64(senteGold&0xF)), sgOffset))
	result.Or(result, new(big.Int).Lsh(big.NewInt(int64(senteBishop&0xF)), sbOffset))
	result.Or(result, new(big.Int).Lsh(big.NewInt(int64(goteGold&0xF)), ggOffset))
	result.Or(result, new(big.Int).Lsh(big.NewInt(int64(goteBishop&0xF)), gbOffset))

	return result
}

func encodeHashFlipped(state GameState) *big.Int {
	hash := big.NewInt(0)
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			flippedY := 3 - y
			flippedX := 3 - x
			piece := state.Board[y][x]
			value := 0
			if piece != nil {
				switch piece.Type {
				case OU:
					value = 1
				case KIN:
					value = 2
				case KAKU:
					value = 3
				}
				if movementType(piece) == UMA {
					value = 4
				}
				if piece.Owner == Sente {
					value = -value
				}
			}
			bit := big.NewInt(int64(value & 0xF))
			pos := flippedY*4 + flippedX
			hash.Or(hash, new(big.Int).Lsh(bit, uint(pos*4)))
		}
	}

	computed := computeHashInternals(state, Gote)
	hash.Or(hash, computed)
	return hash
}

func describePosition(state GameState) map[string]interface{} {
	legalMoves := generateNextStates(state)
	senteKing := findKingCoords(state.Board, Sente)
	goteKing := findKingCoords(state.Board, Gote)

	var capturablePieces []map[string]interface{}
	for _, move := range legalMoves {
		if r, ok := move.Record.(BoardMoveRecord); ok {
			if state.Board[r.ToY][r.ToX] != nil && state.Board[r.ToY][r.ToX].Owner == opponent(state.Turn) {
				capturablePieces = append(capturablePieces, map[string]interface{}{
					"move":   move.Japanese,
					"square": coordToJapanese(r.ToX, r.ToY),
					"piece":  pieceNames[state.Board[r.ToY][r.ToX].Type],
				})
			}
		}
	}

	result := map[string]interface{}{
		"turn":            string(state.Turn),
		"inCheck":         isKingInCheck(state.Board, state.Turn),
		"legalMoveCount":  len(legalMoves),
		"capturablePieces": capturablePieces,
		"attacks": map[string]interface{}{
			"sente": collectAttacks(state, Sente),
			"gote":  collectAttacks(state, Gote),
		},
	}

	if senteKing != nil {
		result["kings"] = map[string]interface{}{
			"sente": map[string]interface{}{
				"x": senteKing.x, "y": senteKing.y,
				"square": coordToJapanese(senteKing.x, senteKing.y),
			},
			"gote": map[string]interface{}{
				"x": goteKing.x, "y": goteKing.y,
				"square": coordToJapanese(goteKing.x, goteKing.y),
			},
		}
		if goteKing != nil {
			result["kingDistance"] = map[string]interface{}{
				"manhattan": abs(senteKing.x-goteKing.x) + abs(senteKing.y-goteKing.y),
				"chebyshev": max(abs(senteKing.x-goteKing.x), abs(senteKing.y-goteKing.y)),
			}
		}
	}

	return result
}

func collectAttacks(state GameState, owner Player) []map[string]interface{} {
	var attacks []map[string]interface{}
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			piece := state.Board[y][x]
			if piece == nil || piece.Owner != owner {
				continue
			}
			for targetY := 0; targetY < rows; targetY++ {
				for targetX := 0; targetX < cols; targetX++ {
					if x == targetX && y == targetY {
						continue
					}
					target := state.Board[targetY][targetX]
					var board Board
					if target != nil && target.Owner == owner {
						board = boardWithoutTarget(state.Board, targetX, targetY)
					} else {
						board = state.Board
					}
					sel := boardSelection{x: x, y: y, piece: piece}
					if !isPseudoLegalMove(sel, targetX, targetY, board) {
						continue
					}
					entry := map[string]interface{}{
						"piece": pieceNames[movementType(piece)],
						"from":  coordToJapanese(x, y),
						"to":    coordToJapanese(targetX, targetY),
					}
					if target != nil {
						entry["target"] = pieceNames[target.Type]
					} else {
						entry["target"] = nil
					}
					attacks = append(attacks, entry)
				}
			}
		}
	}
	return attacks
}

// ヘルパー関数

func sign(x int) int {
	if x > 0 {
		return 1
	} else if x < 0 {
		return -1
	}
	return 0
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func copyBoard(board Board) Board {
	var copied Board
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			if board[y][x] != nil {
				p := *board[y][x]
				copied[y][x] = &p
			}
		}
	}
	return copied
}

func findKing(board Board, owner Player) (int, int) {
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			if board[y][x] != nil && board[y][x].Owner == owner && board[y][x].Type == OU {
				return x, y
			}
		}
	}
	return -1, -1
}

func findKingCoords(board Board, owner Player) *struct{ x, y int } {
	x, y := findKing(board, owner)
	if x < 0 {
		return nil
	}
	return &struct{ x, y int }{x, y}
}

func addToHand(hands Hands, player Player, pt PieceType) Hands {
	if player == Sente {
		hands.Sente = append(hands.Sente, pt)
	} else {
		hands.Gote = append(hands.Gote, pt)
	}
	return hands
}

func removeFromHand(hands Hands, player Player, index int) Hands {
	if player == Sente {
		hands.Sente = append(hands.Sente[:index], hands.Sente[index+1:]...)
	} else {
		hands.Gote = append(hands.Gote[:index], hands.Gote[index+1:]...)
	}
	return hands
}

func indexOfHand(hands Hands, player Player, pt PieceType) int {
	hand := getHand(hands, player)
	for i, p := range hand {
		if p == pt {
			return i
		}
	}
	return -1
}

func getHand(hands Hands, player Player) []PieceType {
	if player == Sente {
		return hands.Sente
	}
	return hands.Gote
}

func countHand(hand []PieceType, pt PieceType) int {
	count := 0
	for _, p := range hand {
		if p == pt {
			count++
		}
	}
	return count
}

func boardWithoutTarget(board Board, targetX, targetY int) Board {
	copied := copyBoard(board)
	copied[targetY][targetX] = nil
	return copied
}

func pieceToSFEN(piece Piece) string {
	mt := movementType(&piece)
	var symbol string
	switch mt {
	case OU:
		symbol = "K"
	case KIN:
		symbol = "G"
	case KAKU:
		symbol = "B"
	case UMA:
		symbol = "+B"
	}
	if piece.Owner == Gote {
		return strings.ToLower(symbol)
	}
	return symbol
}

func handsToSFEN(state GameState) string {
	var parts []string
	type pair struct {
		owner Player
		pt    PieceType
	}
	for _, p := range []pair{
		{Sente, KAKU}, {Sente, KIN}, {Gote, KAKU}, {Gote, KIN},
	} {
		hand := getHand(state.Hands, p.owner)
		count := countHand(hand, p.pt)
		if count == 0 {
			continue
		}
		symbol := "B"
		if p.pt == KIN {
			symbol = "G"
		}
		if p.owner == Gote {
			symbol = strings.ToLower(symbol)
		}
		if count > 1 {
			parts = append(parts, fmt.Sprintf("%d%s", count, symbol))
		} else {
			parts = append(parts, symbol)
		}
	}
	if len(parts) == 0 {
		return "-"
	}
	return strings.Join(parts, "")
}