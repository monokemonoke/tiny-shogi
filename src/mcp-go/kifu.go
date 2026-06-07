package main

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

func pieceToChar(pt PieceType) string {
	switch pt {
	case OU:
		return "O"
	case KIN:
		return "G"
	case KAKU, UMA:
		return "K"
	default:
		return "?"
	}
}

func charToPiece(char string) (PieceType, error) {
	switch char {
	case "O":
		return OU, nil
	case "G":
		return KIN, nil
	case "K":
		return KAKU, nil
	default:
		return "", fmt.Errorf("不正な駒文字です: %s", char)
	}
}

func encodeMove(record MoveRecord) string {
	switch r := record.(type) {
	case BoardMoveRecord:
		promoteStr := ""
		if r.Promote {
			promoteStr = "+"
		}
		return fmt.Sprintf("%s%s%s", coordToKifu(r.FromX, r.FromY), coordToKifu(r.ToX, r.ToY), promoteStr)
	case HandMoveRecord:
		return fmt.Sprintf("%s%s", pieceToChar(r.Piece), coordToKifu(r.ToX, r.ToY))
	}
	return ""
}

func decodeMove(value string) (MoveRecord, error) {
	if len(value) == 0 {
		return nil, fmt.Errorf("空の文字列です")
	}
	if value[0] >= 'A' && value[0] <= 'Z' {
		piece, err := charToPiece(string(value[0]))
		if err != nil {
			return nil, err
		}
		toX, toY, err := kifuToCoord(value[1:3])
		if err != nil {
			return nil, err
		}
		return HandMoveRecord{Type: "hand", ToX: toX, ToY: toY, Piece: piece, Promote: false}, nil
	}
	fromX, fromY, err := kifuToCoord(value[0:2])
	if err != nil {
		return nil, err
	}
	toX, toY, err := kifuToCoord(value[2:4])
	if err != nil {
		return nil, err
	}
	return BoardMoveRecord{
		Type:    "board",
		FromX:   fromX,
		FromY:   fromY,
		ToX:     toX,
		ToY:     toY,
		Promote: strings.Contains(value, "+"),
	}, nil
}

func encodeKifu(moves []MoveRecord) string {
	parts := make([]string, len(moves))
	for i, move := range moves {
		parts[i] = encodeMove(move)
	}
	return strings.Join(parts, "-")
}

func decodeKifu(value string) ([]MoveRecord, error) {
	kifu := extractKifuString(value)
	if kifu == "" {
		return nil, nil
	}
	parts := strings.Split(kifu, "-")
	var records []MoveRecord
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		record, err := decodeMove(part)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, nil
}

func extractKifuString(input string) string {
	value := strings.TrimSpace(input)
	if value == "" {
		return ""
	}
	if strings.Contains(value, "://") {
		u, err := url.Parse(value)
		if err != nil {
			return ""
		}
		return u.Query().Get("m")
	}
	query := value
	if strings.HasPrefix(query, "?") {
		query = query[1:]
	}
	if strings.HasPrefix(query, "m=") {
		params, err := url.ParseQuery(query)
		if err != nil {
			return ""
		}
		return params.Get("m")
	}
	return value
}

type ReplayResult struct {
	Input         string
	Moves         []ReplayMove
	Positions     []PositionSnapshot
	FinalPosition *PositionSnapshot
}

type ReplayMove struct {
	Ply      int
	Record   MoveRecord
	Japanese string
	Hash     string
}

func replayKifu(input string, moveLimit *int) (*ReplayResult, error) {
	records, err := decodeKifu(input)
	if err != nil {
		return nil, fmt.Errorf("棋譜のデコードに失敗しました: %w", err)
	}
	limit := len(records)
	if moveLimit != nil && *moveLimit < limit {
		limit = *moveLimit
	}

	state := createInitialState()
	positions := []PositionSnapshot{snapshot(0, state)}
	var moves []ReplayMove

	for i := 0; i < limit; i++ {
		record := records[i]
		newState, enriched, japanese, err := applyMoveRecord(state, record)
		if err != nil {
			return nil, fmt.Errorf("手 %d の適用に失敗しました: %w", i+1, err)
		}
		state = newState
		pos := snapshot(i+1, state)
		positions = append(positions, pos)
		moves = append(moves, ReplayMove{
			Ply:      i + 1,
			Record:   enriched,
			Japanese: japanese,
			Hash:     pos.Hash,
		})
	}

	result := &ReplayResult{
		Input:     extractKifuString(input),
		Moves:     moves,
		Positions: positions,
	}
	if len(positions) > 0 {
		final := positions[len(positions)-1]
		result.FinalPosition = &final
	}
	return result, nil
}

func snapshot(ply int, state GameState) PositionSnapshot {
	cloned := cloneState(state)
	return PositionSnapshot{
		Ply:      ply,
		Turn:     cloned.Turn,
		Hash:     HashCalc.HashToString(HashCalc.CalcHash(cloned)),
		SFENLike: stateToSFENLike(cloned),
		State:    cloned,
	}
}

func resolvePosition(input PositionInput) (*PositionSnapshot, error) {
	if input.State != nil {
		ply := 0
		if input.Ply != nil {
			ply = *input.Ply
		}
		pos := snapshot(ply, *input.State)
		return &pos, nil
	}

	kifu := ""
	if input.Kifu != nil {
		kifu = *input.Kifu
	} else if input.Input != nil {
		kifu = *input.Input
	}

	result, err := replayKifu(kifu, nil)
	if err != nil {
		return nil, err
	}

	ply := len(result.Positions) - 1
	if input.Ply != nil {
		ply = *input.Ply
	}
	if ply < 0 || ply >= len(result.Positions) {
		return nil, fmt.Errorf("指定手数の局面がありません: %d", ply)
	}
	pos := result.Positions[ply]
	return &pos, nil
}

// PositionInput はツールの入力パラメータ
type PositionInput struct {
	Input *string    `json:"input,omitempty"`
	Kifu  *string    `json:"kifu,omitempty"`
	Ply   *int       `json:"ply,omitempty"`
	State *GameState `json:"state,omitempty"`
}

// DecodeKifuInput はdecode_kifu ツールの入力
type DecodeKifuInput struct {
	Input     string `json:"input"`
	MoveLimit *int   `json:"moveLimit,omitempty"`
}

// BestLineInput はget_best_line ツールの入力
type BestLineInput struct {
	PositionInput
	MaxPlies *int `json:"maxPlies,omitempty"`
}

// parseInt のヘルパー
func mustParseInt(s string) (int, error) {
	return strconv.Atoi(s)
}