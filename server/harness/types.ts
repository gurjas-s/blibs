export interface HarnessResult {
  ok: boolean;
  reply: string;
  code: number | null;
  error?: string;
}

/** One coding session that a harness reports for a project. */
export interface HarnessSession {
  id: string;
  title?: string;
  updated?: number;
}

export interface HarnessRun {
  promise: Promise<HarnessResult>;
  kill(): void;
}

/**
 * One MCP server a harness run must expose to its agent. This is the harness
 * contract for MCP compliance: every adapter must connect the agent to these
 * servers, and an adapter that cannot must fail the run with a clear error.
 */
export interface HarnessMcpServer {
  /** Server name the agent sees, for example `blibs-router`. */
  readonly name: string;
  /** Stdio command that starts the MCP server. */
  readonly command: string[];
}

/** Per-run overrides. The harness falls back to its configured values. */
export interface HarnessStartOptions {
  sessionId?: string;
  cwd?: string;
  model?: string;
  mcp?: HarnessMcpServer[];
}

export interface Harness {
  readonly id: string;
  /** Chat trigger that routes one task to this harness, for example `@opencode`. */
  readonly mention: string;
  start(prompt: string, options?: HarnessStartOptions | string): HarnessRun;
  /** List the sessions of one project. A harness without this method has no session list. */
  listSessions?(cwd: string): Promise<HarnessSession[]>;
}
