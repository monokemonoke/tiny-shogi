package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	_ "github.com/mattn/go-sqlite3"
)

type LookupDatabase struct {
	db *sql.DB
}

func OpenLookupDatabase(dbPath string) (*LookupDatabase, error) {
	db, err := sql.Open("sqlite3", dbPath+"?mode=ro")
	if err != nil {
		return nil, fmt.Errorf("データベースを開けません: %w", err)
	}
	return &LookupDatabase{db: db}, nil
}

func (ldb *LookupDatabase) EvaluateHash(hash string) Evaluation {
	row := ldb.db.QueryRow("SELECT value FROM results WHERE hash = ?", hash)
	var value string
	if err := row.Scan(&value); err != nil {
		return Evaluation{Result: EvalUnknown}
	}
	return parseDBValue(value)
}

func (ldb *LookupDatabase) EvaluateState(state GameState) Evaluation {
	hash := HashCalc.HashToString(HashCalc.CalcHash(state))
	return ldb.EvaluateHash(hash)
}

func (ldb *LookupDatabase) Close() {
	ldb.db.Close()
}

func GetDefaultLookupDBPath() string {
	dir, err := os.Getwd()
	if err != nil {
		return "../../solver/data/lookup.db"
	}
	return filepath.Join(dir, "../../solver/data/lookup.db")
}

func parseDBValue(value string) Evaluation {
	var raw interface{}
	if err := json.Unmarshal([]byte(value), &raw); err != nil {
		return Evaluation{Result: EvalUnknown}
	}
	return parseRawEvaluation(raw)
}

func parseRawEvaluation(raw interface{}) Evaluation {
	switch v := raw.(type) {
	case string:
		if v == "Draw" || v == "Sennichite" || v == "千日手" {
			return Evaluation{Result: EvalDraw}
		}
	case map[string]interface{}:
		if winPly, ok := v["Win"]; ok {
			if winPlyFloat, ok := winPly.(float64); ok {
				ply := int(winPlyFloat)
				return Evaluation{Result: EvalWin, Ply: &ply}
			}
		}
		if losePly, ok := v["Lose"]; ok {
			if losePlyFloat, ok := losePly.(float64); ok {
				ply := int(losePlyFloat)
				return Evaluation{Result: EvalLose, Ply: &ply}
			}
		}
		if _, ok := v["Draw"]; ok {
			return Evaluation{Result: EvalDraw}
		}
		if _, ok := v["Sennichite"]; ok {
			return Evaluation{Result: EvalDraw}
		}
	}
	return Evaluation{Result: EvalUnknown}
}