#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createToolHandlers } from './tools.js';
import { getDefaultLookupDbPath } from './lookup.js';

const pieceTypeSchema = z.enum(['OU', 'KIN', 'KAKU', 'UMA']);
const playerSchema = z.enum(['sente', 'gote']);
const pieceSchema = z.object({
  type: pieceTypeSchema,
  owner: playerSchema,
  promoted: z.boolean(),
});
const stateSchema = z.object({
  board: z.array(z.array(pieceSchema.nullable())),
  hands: z.object({
    sente: z.array(pieceTypeSchema),
    gote: z.array(pieceTypeSchema),
  }),
  turn: playerSchema,
});

const positionInputSchema = {
  input: z.string().optional().describe('棋譜m文字列またはURL。kifuと同じ意味です。'),
  kifu: z.string().optional().describe('棋譜m文字列またはURL。省略時は初期局面です。'),
  ply: z.number().int().min(0).optional().describe('棋譜の何手目の局面を使うか。省略時は最終局面です。'),
  state: stateSchema.optional().describe('直接指定する局面。指定時は棋譜より優先します。'),
};

export function createTinyShogiMcpServer(dbPath: string) {
  const server = new McpServer({
    name: 'tiny-shogi-analysis',
    version: '0.1.0',
  });
  const tools = createToolHandlers(dbPath);

  server.registerTool(
    'decode_kifu',
    {
      title: '棋譜を復元',
      description: 'm=棋譜文字列またはURLを初期局面から再生し、各手の局面列・hash・日本語表記・SFEN風表記を返します。',
      inputSchema: {
        input: z.string().describe('m=文字列、?m=...、またはURL。'),
        moveLimit: z.number().int().min(0).optional().describe('先頭から何手まで再生するか。'),
      },
    },
    async (input) => toTextResult(tools.decodeKifu(input)),
  );

  server.registerTool(
    'evaluate_position',
    {
      title: '局面評価',
      description: '棋譜+手数または直接指定局面をlookup.dbで評価します。評価は常に手番側視点の真値です。',
      inputSchema: positionInputSchema,
    },
    async (input) => toTextResult(tools.evaluatePosition(input)),
  );

  server.registerTool(
    'analyze_moves',
    {
      title: '合法手解析',
      description: '全合法手、着手後評価、指し手側視点へ反転した評価、最善手/緩手/敗着/悪手の分類を返します。',
      inputSchema: positionInputSchema,
    },
    async (input) => toTextResult(tools.analyzeMoves(input)),
  );

  server.registerTool(
    'get_best_line',
    {
      title: '最善応手列',
      description: 'lookup.dbの真値を反復して、各局面の最善候補群を返します。タイは複数候補として残します。',
      inputSchema: {
        ...positionInputSchema,
        maxPlies: z.number().int().min(1).max(64).optional().describe('何手先まで反復するか。既定は8、最大64です。'),
      },
    },
    async (input) => toTextResult(tools.getBestLine(input)),
  );

  server.registerTool(
    'describe_position',
    {
      title: '局面の幾何説明',
      description: '王手、取れる駒、玉距離、合法手数などDBに依存しない着眼点を返します。手の正しさは保証しません。',
      inputSchema: positionInputSchema,
    },
    async (input) => toTextResult(tools.describePosition(input)),
  );

  return { server, close: tools.close };
}

function toTextResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function main() {
  const dbPath = process.env.LOOKUP_DB_PATH ?? getDefaultLookupDbPath();
  const { server, close } = createTinyShogiMcpServer(dbPath);
  process.once('SIGINT', () => {
    close();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    close();
    process.exit(0);
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
