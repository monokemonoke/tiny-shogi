package main

import (
	"context"
	"encoding/json"
	"fmt"

	mcp "github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func CreateTinyShogiMcpServer(dbPath string) (*mcpserver.MCPServer, func()) {
	server := mcpserver.NewMCPServer("tiny-shogi-analysis", "0.1.0")

	db, err := OpenLookupDatabase(dbPath)
	if err != nil {
		panic(fmt.Sprintf("lookup.db を開けません: %v", err))
	}
	close := func() {
		db.Close()
	}

	// decode_kifu ツール
	decodeKifuTool := mcp.NewTool("decode_kifu",
		mcp.WithDescription("m=棋譜文字列またはURLを初期局面から再生し、各手の局面列・hash・日本語表記・SFEN風表記を返します。"),
		mcp.WithToolTitle("棋譜を復元"),
		mcp.WithString("input", mcp.Description("m=文字列、?m=...、またはURL。")),
		mcp.WithInteger("moveLimit", mcp.Description("先頭から何手まで再生するか。")),
	)
	server.AddTool(decodeKifuTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		input := req.GetString("input", "")
		moveLimitInt := req.GetInt("moveLimit", 0)
		var moveLimit *int
		if moveLimitInt > 0 {
			moveLimitInt := moveLimitInt
			moveLimit = &moveLimitInt
		}
		result, err := replayKifu(input, moveLimit)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("棋譜の復元に失敗しました: %v", err)), nil
		}

		type serializedMove struct {
			Ply      int    `json:"ply"`
			Move     string `json:"move"`
			Hash     string `json:"hash"`
		}
		type serializedPosition struct {
			Ply      int        `json:"ply"`
			Move     *string    `json:"move"`
			Turn     string     `json:"turn"`
			Hash     string     `json:"hash"`
			SFENLike string     `json:"sfenLike"`
			Board    Board      `json:"board"`
			Hands    Hands      `json:"hands"`
		}

		var moves []serializedMove
		for _, m := range result.Moves {
			moves = append(moves, serializedMove{
				Ply:  m.Ply,
				Move: m.Japanese,
				Hash: m.Hash,
			})
		}

		var positions []serializedPosition
		for i, pos := range result.Positions {
			var moveStr *string
			if i > 0 && len(result.Moves) > i-1 {
				s := result.Moves[i-1].Japanese
				moveStr = &s
			}
			positions = append(positions, serializedPosition{
				Ply:      pos.Ply,
				Move:     moveStr,
				Turn:     string(pos.Turn),
				Hash:     pos.Hash,
				SFENLike: pos.SFENLike,
				Board:    pos.State.Board,
				Hands:    pos.State.Hands,
			})
		}

		output := map[string]interface{}{
			"input":     result.Input,
			"moves":     moves,
			"positions": positions,
		}
		return toTextResult(output), nil
	})

	// evaluate_position ツール
	evaluatePositionTool := mcp.NewTool("evaluate_position",
		mcp.WithDescription("棋譜+手数または直接指定局面をlookup.dbで評価します。評価は常に手番側視点の真値です。"),
		mcp.WithToolTitle("局面評価"),
		mcp.WithString("input", mcp.Description("棋譜m文字列またはURL。kifuと同じ意味です。")),
		mcp.WithString("kifu", mcp.Description("棋譜m文字列またはURL。省略時は初期局面です。")),
		mcp.WithInteger("ply", mcp.Description("棋譜の何手目の局面を使うか。省略時は最終局面です。")),
	)
	server.AddTool(evaluatePositionTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		posInput := parsePositionInput(req)
		position, err := resolvePosition(posInput)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("局面の解決に失敗しました: %v", err)), nil
		}
		output := map[string]interface{}{
			"truthSource": "lookup.db",
			"hash":        position.Hash,
			"turn":         string(position.Turn),
			"sfenLike":    position.SFENLike,
			"evaluation":  db.EvaluateState(position.State),
		}
		return toTextResult(output), nil
	})

	// analyze_moves ツール
	analyzeMovesTool := mcp.NewTool("analyze_moves",
		mcp.WithDescription("全合法手、着手後評価、指し手側視点へ反転した評価、最善手/緩手/敗着/悪手の分類を返します。"),
		mcp.WithToolTitle("合法手解析"),
		mcp.WithString("input", mcp.Description("棋譜m文字列またはURL。kifuと同じ意味です。")),
		mcp.WithString("kifu", mcp.Description("棋譜m文字列またはURL。省略時は初期局面です。")),
		mcp.WithInteger("ply", mcp.Description("棋譜の何手目の局面を使うか。省略時は最終局面です。")),
	)
	server.AddTool(analyzeMovesTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		posInput := parsePositionInput(req)
		position, err := resolvePosition(posInput)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("局面の解決に失敗しました: %v", err)), nil
		}
		analyzed := analyzeMoves(position.State, db)
		output := map[string]interface{}{
			"truthSource":          "lookup.db",
			"perspective":          "評価は指し手側視点です",
			"classificationBasis":  "結果が変わったか、および勝ちは最短ply・負けは最長plyかで分類します。",
			"hash":                 analyzed.Hash,
			"turn":                 analyzed.Turn,
			"currentEvaluation":    analyzed.CurrentEvaluation,
			"moves":                analyzed.Moves,
			"bestMoves":            analyzed.BestMoves,
		}
		return toTextResult(output), nil
	})

	// get_best_line ツール
	getBestLineTool := mcp.NewTool("get_best_line",
		mcp.WithDescription("lookup.dbの真値を反復して、各局面の最善候補群を返します。タイは複数候補として残します。"),
		mcp.WithToolTitle("最善応手列"),
		mcp.WithString("input", mcp.Description("棋譜m文字列またはURL。kifuと同じ意味です。")),
		mcp.WithString("kifu", mcp.Description("棋譜m文字列またはURL。省略時は初期局面です。")),
		mcp.WithInteger("ply", mcp.Description("棋譜の何手目の局面を使うか。省略時は最終局面です。")),
		mcp.WithInteger("maxPlies", mcp.Description("何手先まで反復するか。既定は8、最大64です。")),
	)
	server.AddTool(getBestLineTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		posInput := parsePositionInput(req)
		position, err := resolvePosition(posInput)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("局面の解決に失敗しました: %v", err)), nil
		}
		maxPliesInt := req.GetInt("maxPlies", 8)
		if maxPliesInt < 1 {
			maxPliesInt = 1
		}
		if maxPliesInt > 64 {
			maxPliesInt = 64
		}
		result := getBestLine(position.State, db, maxPliesInt)
		output := map[string]interface{}{
			"truthSource":   "lookup.db",
			"perspective":   "各手の評価はその手を指した側の視点です",
			"steps":         result.Steps,
			"stoppedReason": result.StoppedReason,
		}
		return toTextResult(output), nil
	})

	// describe_position ツール
	describePositionTool := mcp.NewTool("describe_position",
		mcp.WithDescription("王手、取れる駒、玉距離、合法手数などDBに依存しない着眼点を返します。手の正しさは保証しません。"),
		mcp.WithToolTitle("局面の幾何説明"),
		mcp.WithString("input", mcp.Description("棋譜m文字列またはURL。kifuと同じ意味です。")),
		mcp.WithString("kifu", mcp.Description("棋譜m文字列またはURL。省略時は初期局面です。")),
		mcp.WithInteger("ply", mcp.Description("棋譜の何手目の局面を使うか。省略時は最終局面です。")),
	)
	server.AddTool(describePositionTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		posInput := parsePositionInput(req)
		position, err := resolvePosition(posInput)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("局面の解決に失敗しました: %v", err)), nil
		}
		description := describePosition(position.State)
		output := map[string]interface{}{
			"hash":       position.Hash,
			"turn":        string(position.Turn),
			"sfenLike":   position.SFENLike,
			"note":       "幾何情報のみです。手の良し悪しはlookup.dbの評価で確認してください。",
			"description": description,
		}
		return toTextResult(output), nil
	})

	return server, close
}

func parsePositionInput(req mcp.CallToolRequest) PositionInput {
	args := req.GetArguments()
	var input PositionInput
	if v, ok := args["input"]; ok && v != nil {
		if s, ok := v.(string); ok {
			input.Input = &s
		}
	}
	if v, ok := args["kifu"]; ok && v != nil {
		if s, ok := v.(string); ok {
			input.Kifu = &s
		}
	}
	if v, ok := args["ply"]; ok && v != nil {
		switch n := v.(type) {
		case float64:
			ply := int(n)
			input.Ply = &ply
		case int:
			input.Ply = &n
		}
	}
	return input
}

func toTextResult(value interface{}) *mcp.CallToolResult {
	jsonBytes, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		jsonBytes = []byte(fmt.Sprintf("%v", value))
	}
	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: string(jsonBytes),
			},
		},
	}
}