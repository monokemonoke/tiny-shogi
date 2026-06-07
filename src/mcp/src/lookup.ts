import path from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseConstructor, { Database as DatabaseHandle } from 'better-sqlite3';
import { Evaluation, GameState } from './types.js';
import { HashCalc } from './shogi.js';

export class LookupDatabase {
  private readonly statement;

  constructor(private readonly database: DatabaseHandle) {
    this.statement = this.database.prepare('SELECT value FROM results WHERE hash = ?');
  }

  evaluateHash(hash: string): Evaluation {
    const row = this.statement.get(hash) as { value: string } | undefined;
    return row ? parseDbValue(row.value) : { result: 'unknown' };
  }

  evaluateState(state: GameState): Evaluation {
    return this.evaluateHash(HashCalc.hashToString(HashCalc.calcHash(state)));
  }

  close(): void {
    this.database.close();
  }
}

export function openLookupDatabase(dbPath = getDefaultLookupDbPath()): LookupDatabase {
  return new LookupDatabase(new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true }));
}

export function getDefaultLookupDbPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '../../solver/data/lookup.db');
}

export function parseDbValue(value: string): Evaluation {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parseRawEvaluation(parsed);
  } catch {
    return { result: 'unknown' };
  }
}

export function parseRawEvaluation(raw: unknown): Evaluation {
  if (raw === 'Draw' || raw === 'Sennichite' || raw === '千日手') return { result: 'draw' };
  if (!raw || typeof raw !== 'object') return { result: 'unknown' };
  const data = raw as Record<string, unknown>;
  if (typeof data.Win === 'number') return { result: 'win', ply: data.Win };
  if (typeof data.Lose === 'number') return { result: 'lose', ply: data.Lose };
  if (data.Draw !== undefined || data.Sennichite !== undefined) return { result: 'draw' };
  return { result: 'unknown' };
}
