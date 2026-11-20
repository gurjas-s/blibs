export interface HarnessResult {
  ok: boolean;
  reply: string;
  code: number | null;
  error?: string;
}

export interface HarnessRun {
  promise: Promise<HarnessResult>;
  kill(): void;
}

/** Per-run overrides. The harness falls back to its configured values. */
export interface HarnessStartOptions {
  sessionId?: string;
  cwd?: string;
  model?: string;
}

export interface Harness {
  readonly id: string;
  /** Chat trigger that routes one task to this harness, for example `@opencode`. */
  readonly mention: string;
  start(prompt: string, options?: HarnessStartOptions | string): HarnessRun;
}
