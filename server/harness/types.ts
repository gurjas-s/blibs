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

export interface Harness {
  readonly id: string;
  start(prompt: string, sessionId?: string): HarnessRun;
}
