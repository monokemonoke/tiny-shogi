package main

type Player string

const (
	Sente Player = "sente"
	Gote  Player = "gote"
)

type PieceType string

const (
	OU   PieceType = "OU"
	KIN  PieceType = "KIN"
	KAKU PieceType = "KAKU"
	UMA  PieceType = "UMA"
)

type Piece struct {
	Type     PieceType `json:"type"`
	Owner    Player    `json:"owner"`
	Promoted bool      `json:"promoted"`
}

type Board [4][4]*Piece

type Hands struct {
	Sente []PieceType `json:"sente"`
	Gote  []PieceType `json:"gote"`
}

type GameState struct {
	Board Board `json:"board"`
	Hands Hands `json:"hands"`
	Turn  Player `json:"turn"`
}

type BoardMoveRecord struct {
	Type    string    `json:"type"`
	FromX   int       `json:"fromX"`
	FromY   int       `json:"fromY"`
	ToX     int       `json:"toX"`
	ToY     int       `json:"toY"`
	Piece   *PieceType `json:"piece,omitempty"`
	Promote bool      `json:"promote"`
}

type HandMoveRecord struct {
	Type    string   `json:"type"`
	ToX     int      `json:"toX"`
	ToY     int      `json:"toY"`
	Piece   PieceType `json:"piece"`
	Promote bool     `json:"promote"`
}

type MoveRecord interface{}

type GeneratedMove struct {
	State   GameState
	Record  MoveRecord
	Japanese string
}

type EvaluationResult string

const (
	EvalWin    EvaluationResult = "win"
	EvalLose   EvaluationResult = "lose"
	EvalDraw   EvaluationResult = "draw"
	EvalUnknown EvaluationResult = "unknown"
)

type Evaluation struct {
	Result EvaluationResult `json:"result"`
	Ply    *int             `json:"ply,omitempty"`
}

type MoveClassification string

const (
	ClassBest         MoveClassification = "best"
	ClassInaccuracy   MoveClassification = "inaccuracy"
	ClassBlunder      MoveClassification = "blunder"
	ClassMistake      MoveClassification = "mistake"
	ClassUnknown      MoveClassification = "unknown"
)

type ClassifiedMove struct {
	ID                 string         `json:"id"`
	EvaluationForMover Evaluation    `json:"evaluationForMover"`
	Classification     MoveClassification `json:"classification"`
	PlyDelta           *int           `json:"plyDelta"`
	IsBest             bool           `json:"isBest"`
}

type PositionSnapshot struct {
	Ply      int        `json:"ply"`
	Turn     Player     `json:"turn"`
	Hash     string     `json:"hash"`
	SFENLike string     `json:"sfenLike"`
	State    GameState  `json:"state"`
}