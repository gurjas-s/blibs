// blibs router MCP server: project and session tools for the routing agent.
//
// The relay attaches this server to every routing run. The agent calls the
// tools to resolve the project for one provider message and the coding session
// that project owns. The tools only read the relay state and the home folder.
// The relay stays the single writer and enforces the project allowlist before
// a harness launch.
//
// Run: node build/server/router-mcp.js --data-dir <history dir>
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseSessions, parseStringArray, readRelayStateFile } from './relay-state.js';
import { searchHomeProjects } from './harness/discovery.js';
import {
  clarificationText,
  listCandidates,
  resolveProject,
  sessionKey,
  threadProjects,
} from './harness/router.js';
import type { ProjectRegistry } from './harness/router.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function dataDirFromArgs(argv: string[]): string {
  const flag = argv.indexOf('--data-dir');
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  if (process.env.BLIBS_DATA_DIR) return process.env.BLIBS_DATA_DIR;
  return process.cwd();
}

function searchRootFromArgs(argv: string[]): string {
  const flag = argv.indexOf('--search-root');
  if (flag !== -1 && argv[flag + 1]) return path.resolve(argv[flag + 1]);
  if (process.env.BLIBS_RELAY_SEARCH_ROOT) return path.resolve(process.env.BLIBS_RELAY_SEARCH_ROOT);
  return os.homedir();
}

function readState(dataDir: string): { registry: ProjectRegistry; sessions: Record<string, string> } {
  const fallback: ProjectRegistry = { projects: [], discoveryRoot: path.join(dataDir, 'harness') };
  const raw = readRelayStateFile(path.join(dataDir, 'relay-state.json'));
  if (!raw) return { registry: fallback, sessions: {} };
  const discoveryRoot = typeof raw.discoveryRoot === 'string' && raw.discoveryRoot ? raw.discoveryRoot : fallback.discoveryRoot;
  return {
    registry: { projects: parseStringArray(raw.projects), discoveryRoot },
    sessions: parseSessions(raw.sessions),
  };
}

function textResult(value: unknown): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

const TOOLS = [
  {
    name: 'get_thread_projects',
    description: 'List project paths with coding sessions in one provider conversation, most recent last.',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string', description: 'Provider conversation URL' } },
      required: ['threadId'],
    },
  },
  {
    name: 'list_projects',
    description: 'List registered projects, the discovery root, and current candidates.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resolve_project',
    description: 'Pick the project for one provider message. A null projectPath means ask the user, using clarification.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Provider message text behind the harness mention' },
        threadId: { type: 'string', description: 'Provider conversation URL' },
      },
      required: ['task', 'threadId'],
    },
  },
  {
    name: 'resolve_session',
    description: 'Return the coding session of one project in one provider conversation. A null session means the project has no session yet.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Provider conversation URL' },
        projectPath: { type: 'string', description: 'Absolute project path' },
      },
      required: ['threadId', 'projectPath'],
    },
  },
  {
    name: 'search_projects',
    description: 'Search the user home folder for project folders outside the blibs registry. Use this only for a $find-project request.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Maximum projects to return, 1 to 80' },
      },
    },
  },
];

function callTool(name: string, args: Record<string, unknown>, dataDir: string, searchRoot: string): unknown {
  const { registry, sessions } = readState(dataDir);
  if (name === 'get_thread_projects') {
    if (typeof args.threadId !== 'string' || !args.threadId) throw new Error('threadId must be a string');
    return { projects: threadProjects(sessions, args.threadId) };
  }
  if (name === 'list_projects') {
    return { ...registry, candidates: listCandidates(registry) };
  }
  if (name === 'resolve_project') {
    if (typeof args.task !== 'string' || !args.task.trim()) throw new Error('task must be a string');
    if (typeof args.threadId !== 'string' || !args.threadId) throw new Error('threadId must be a string');
    const candidates = listCandidates(registry);
    const known = threadProjects(sessions, args.threadId);
    if (known.length === 0 && candidates.length === 0) {
      return { projectPath: null, confidence: 'single-root', clarification: '' };
    }
    const resolved = resolveProject(args.task, known, candidates);
    if (!resolved) return { projectPath: null, confidence: 'unclear', clarification: clarificationText(candidates, known) };
    return { projectPath: resolved.projectPath, confidence: resolved.confidence, clarification: '' };
  }
  if (name === 'resolve_session') {
    if (typeof args.threadId !== 'string' || !args.threadId) throw new Error('threadId must be a string');
    if (typeof args.projectPath !== 'string' || !args.projectPath.trim()) throw new Error('projectPath must be a string');
    const session = sessions[sessionKey(args.threadId, args.projectPath)];
    return { projectPath: path.resolve(args.projectPath), session: session ?? null };
  }
  if (name === 'search_projects') {
    const maxResults = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
      ? Math.min(80, Math.max(1, Math.floor(args.maxResults)))
      : 80;
    return searchHomeProjects({ root: searchRoot, maxProjects: maxResults });
  }
  throw new Error(`unknown tool: ${name}`);
}

function respond(id: string | number | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id: string | number | null, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const argv = process.argv.slice(2);
const dataDir = dataDirFromArgs(argv);
const searchRoot = searchRootFromArgs(argv);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    respondError(null, -32700, 'invalid JSON');
    return;
  }
  const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  try {
    if (request.method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'blibs-router', version: '1.0.0' },
      });
    } else if (request.method === 'tools/list') {
      respond(id, { tools: TOOLS });
    } else if (request.method === 'tools/call') {
      const name = request.params?.name ?? '';
      const args = request.params?.arguments ?? {};
      respond(id, textResult(callTool(name, args, dataDir, searchRoot)));
    } else if (request.method === 'ping') {
      respond(id, {});
    } else if (request.method === undefined || request.method.startsWith('notifications/')) {
      // No reply for notifications.
    } else {
      respondError(id, -32601, `unknown method: ${request.method ?? ''}`);
    }
  } catch (error) {
    respondError(id, -32602, (error as Error).message);
  }
});
