// Harness selection for the relay.
//
// The relay modules stay harness-generic: the relay config names a harness id,
// and this registry turns the id into the default command and the adapter. A
// new harness adds one entry to HARNESS_KINDS; no relay module changes.
import { OPENCODE_COMMAND, OpenCodeHarness } from './opencode.js';
import { OPENCODE_MENTION } from './mention.js';
import type { Harness } from './types.js';

/** Config values every adapter accepts from the relay. */
export interface HarnessOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
}

/** One harness blibs can drive. */
export interface HarnessKind {
  /** Harness id, for example `opencode`. */
  readonly id: string;
  /** Display name, for example `OpenCode`. */
  readonly name: string;
  /** Chat trigger that routes one task to this harness. */
  readonly mention: string;
  /** Default harness command when no override is set. */
  readonly defaultCommand: string;
  /** Build one adapter from the relay config values. */
  create(options: HarnessOptions): Harness;
}

const OPENCODE_KIND: HarnessKind = {
  id: 'opencode',
  name: 'OpenCode',
  mention: OPENCODE_MENTION,
  defaultCommand: OPENCODE_COMMAND,
  create: (options) => new OpenCodeHarness(options),
};

/** Every harness blibs can drive. The first entry is the relay default. */
export const HARNESS_KINDS: readonly HarnessKind[] = [OPENCODE_KIND];

/** The relay default. The relay uses it when no harness id is set. */
export function defaultHarness(): HarnessKind {
  return HARNESS_KINDS[0];
}

/** Resolve one harness id. An unknown id falls back to the default harness. */
export function harnessKind(id: string | undefined): HarnessKind {
  return HARNESS_KINDS.find((kind) => kind.id === id) ?? defaultHarness();
}
