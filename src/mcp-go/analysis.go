package main

import "fmt"

type moveInput struct {
	id                 string
	evaluationForMover Evaluation
}

func classifyAnalyzedMoves(current Evaluation, moves []moveInput) []ClassifiedMove {
	bestIDs := selectBestMoveIDs(current, moves)
	bestSet := make(map[string]bool)
	for _, id := range bestIDs {
		bestSet[id] = true
	}

	result := make([]ClassifiedMove, len(moves))
	for i, move := range moves {
		classification := classifyMove(current, move.evaluationForMover, bestSet[move.id])
		var plyDelta *int
		if current.Result == move.evaluationForMover.Result && current.Ply != nil && move.evaluationForMover.Ply != nil {
			delta := *move.evaluationForMover.Ply - *current.Ply
			plyDelta = &delta
		}
		result[i] = ClassifiedMove{
			ID:                 move.id,
			EvaluationForMover: move.evaluationForMover,
			Classification:     classification,
			PlyDelta:           plyDelta,
			IsBest:             bestSet[move.id],
		}
	}
	return result
}

func selectBestMoveIDs(current Evaluation, moves []moveInput) []string {
	if len(moves) == 0 {
		return nil
	}

	if current.Result == EvalWin {
		var finite []moveInput
		for _, m := range moves {
			if m.evaluationForMover.Result == EvalWin && m.evaluationForMover.Ply != nil {
				finite = append(finite, m)
			}
		}
		if len(finite) == 0 {
			return nil
		}
		minPly := *finite[0].evaluationForMover.Ply
		for _, m := range finite[1:] {
			if *m.evaluationForMover.Ply < minPly {
				minPly = *m.evaluationForMover.Ply
			}
		}
		var result []string
		for _, m := range finite {
			if *m.evaluationForMover.Ply == minPly {
				result = append(result, m.id)
			}
		}
		return result
	}

	if current.Result == EvalDraw {
		var draws []string
		var wins []string
		for _, m := range moves {
			if m.evaluationForMover.Result == EvalDraw {
				draws = append(draws, m.id)
			}
			if m.evaluationForMover.Result == EvalWin {
				wins = append(wins, m.id)
			}
		}
		if len(draws) > 0 {
			return draws
		}
		return wins
	}

	if current.Result == EvalLose {
		var improvements []moveInput
		for _, m := range moves {
			if resultRank(m.evaluationForMover.Result) > resultRank(current.Result) {
				improvements = append(improvements, m)
			}
		}
		if len(improvements) > 0 {
			bestRank := resultRank(improvements[0].evaluationForMover.Result)
			for _, m := range improvements[1:] {
				r := resultRank(m.evaluationForMover.Result)
				if r > bestRank {
					bestRank = r
				}
			}
			var result []string
			for _, m := range improvements {
				if resultRank(m.evaluationForMover.Result) == bestRank {
					result = append(result, m.id)
				}
			}
			return result
		}

		var finite []moveInput
		for _, m := range moves {
			if m.evaluationForMover.Result == EvalLose && m.evaluationForMover.Ply != nil {
				finite = append(finite, m)
			}
		}
		if len(finite) == 0 {
			return nil
		}
		maxPly := *finite[0].evaluationForMover.Ply
		for _, m := range finite[1:] {
			if *m.evaluationForMover.Ply > maxPly {
				maxPly = *m.evaluationForMover.Ply
			}
		}
		var result []string
		for _, m := range finite {
			if *m.evaluationForMover.Ply == maxPly {
				result = append(result, m.id)
			}
		}
		return result
	}

	return nil
}

func classifyMove(current, eval Evaluation, isBest bool) MoveClassification {
	if eval.Result == EvalUnknown || current.Result == EvalUnknown {
		return ClassUnknown
	}
	if isBest {
		return ClassBest
	}
	if current.Result == EvalWin && eval.Result == EvalWin {
		return ClassInaccuracy
	}
	if current.Result == EvalWin && eval.Result != EvalWin {
		return ClassBlunder
	}
	if current.Result == EvalDraw && eval.Result == EvalLose {
		return ClassMistake
	}
	if current.Result == eval.Result {
		return ClassInaccuracy
	}
	if resultRank(eval.Result) < resultRank(current.Result) {
		return ClassMistake
	}
	return ClassBest
}

func resultRank(result EvaluationResult) int {
	switch result {
	case EvalWin:
		return 3
	case EvalDraw:
		return 2
	case EvalLose:
		return 1
	default:
		return 0
	}
}

func invertEvaluation(eval Evaluation) Evaluation {
	switch eval.Result {
	case EvalWin:
		return Evaluation{Result: EvalLose, Ply: eval.Ply}
	case EvalLose:
		return Evaluation{Result: EvalWin, Ply: eval.Ply}
	default:
		return eval
	}
}

type AnalyzeMovesResult struct {
	Hash              string                   `json:"hash"`
	Turn              string                   `json:"turn"`
	CurrentEvaluation Evaluation              `json:"currentEvaluation"`
	Moves             []AnalyzedMove           `json:"moves"`
	BestMoves         []AnalyzedMove           `json:"bestMoves"`
}

type AnalyzedMove struct {
	Index              int            `json:"index"`
	Move               string         `json:"move"`
	Record             MoveRecord      `json:"record"`
	Hash               string         `json:"hash"`
	ChildEvaluation    Evaluation     `json:"childEvaluation"`
	EvaluationForMover Evaluation     `json:"evaluationForMover"`
	Classification     MoveClassification `json:"classification"`
	ClassificationLabel string         `json:"classificationLabel"`
	PlyDelta           *int           `json:"plyDelta"`
	IsBest             bool           `json:"isBest"`
}

func analyzeMoves(state GameState, db *LookupDatabase) *AnalyzeMovesResult {
	currentEvaluation := db.EvaluateState(state)
	generated := generateNextStates(state)
	moveInputs := make([]moveInput, len(generated))
	for i, move := range generated {
		moveInputs[i] = moveInput{
			id:                 fmt.Sprintf("%d", i),
			evaluationForMover: invertEvaluation(db.EvaluateState(move.State)),
		}
	}
	classified := classifyAnalyzedMoves(currentEvaluation, moveInputs)

	moves := make([]AnalyzedMove, len(generated))
	for i, move := range generated {
		nextHash := HashCalc.HashToString(HashCalc.CalcHash(move.State))
		cl := classified[i]
		moves[i] = AnalyzedMove{
			Index:              i,
			Move:               move.Japanese,
			Record:             move.Record,
			Hash:               nextHash,
			ChildEvaluation:    db.EvaluateState(move.State),
			EvaluationForMover: cl.EvaluationForMover,
			Classification:     cl.Classification,
			ClassificationLabel: classificationLabel(cl.Classification),
			PlyDelta:           cl.PlyDelta,
			IsBest:             cl.IsBest,
		}
	}

	var bestMoves []AnalyzedMove
	for _, m := range moves {
		if m.IsBest {
			bestMoves = append(bestMoves, m)
		}
	}

	return &AnalyzeMovesResult{
		Hash:              HashCalc.HashToString(HashCalc.CalcHash(state)),
		Turn:              string(state.Turn),
		CurrentEvaluation: currentEvaluation,
		Moves:             moves,
		BestMoves:         bestMoves,
	}
}

type BestLineResult struct {
	Steps         []BestLineStep `json:"steps"`
	StoppedReason string         `json:"stoppedReason"`
}

type BestLineStep struct {
	Ply       int            `json:"ply"`
	Hash      string         `json:"hash"`
	Turn      string         `json:"turn"`
	BestMoves []AnalyzedMove `json:"bestMoves"`
}

func getBestLine(state GameState, db *LookupDatabase, maxPlies int) *BestLineResult {
	var steps []BestLineStep
	current := state

	for ply := 0; ply < maxPlies; ply++ {
		analyzed := analyzeMoves(current, db)
		step := BestLineStep{
			Ply:       ply,
			Hash:      analyzed.Hash,
			Turn:      analyzed.Turn,
			BestMoves: analyzed.BestMoves,
		}
		steps = append(steps, step)
		if len(analyzed.BestMoves) == 0 {
			return &BestLineResult{Steps: steps, StoppedReason: "no_legal_moves"}
		}
		selected := analyzed.BestMoves[0]
		generated := generateNextStates(current)
		if selected.Index >= len(generated) {
			return &BestLineResult{Steps: steps, StoppedReason: "internal_mismatch"}
		}
		current = generated[selected.Index].State
	}

	return &BestLineResult{Steps: steps, StoppedReason: "max_plies"}
}

func classificationLabel(classification MoveClassification) string {
	switch classification {
	case ClassBest:
		return "最善手"
	case ClassInaccuracy:
		return "緩手"
	case ClassBlunder:
		return "敗着"
	case ClassMistake:
		return "悪手"
	default:
		return "不明"
	}
}