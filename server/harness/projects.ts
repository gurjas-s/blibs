import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectChoice } from './project-reply.js';

/** Project folders read from one projects directory. */
export const PROJECT_LIMIT = 200;
/** Length limit for one project path. */
export const PROJECT_PATH_LIMIT = 500;

const PATH_TOKEN = /(~[\\/][^\s:'"]+|[a-zA-Z]:[\\/][^\s:'"]+|\/[^\s:'"]+)/g;
const DOLLAR_TOKEN = /^\s*\$(\S+)/;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Canonical form for stored paths. Missing paths stay resolved but unresolved. */
export function canonicalDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export function insideDir(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Absolute projects directory. */
export function projectsRoot(value: string): string {
  return path.resolve(expandHome(value));
}

/** Immediate subfolders of the projects directory, sorted by name. */
export function listProjects(root: string): string[] {
  const found: string[] = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      found.push(path.join(root, entry.name));
      if (found.length >= PROJECT_LIMIT) break;
    }
  } catch {
    // A missing projects directory means no projects.
  }
  return found.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/** Find an explicit filesystem path in the task text. */
function findExplicitPath(text: string): { path: string; index: number; length: number } | null {
  for (const match of text.matchAll(PATH_TOKEN)) {
    const index = match.index ?? 0;
    if (index > 0 && !/[\s('"`]/.test(text[index - 1])) continue;
    const cleaned = match[0].replace(TRAILING_PUNCTUATION, '');
    if (cleaned.length > 1) return { path: cleaned, index, length: match[0].length };
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the text names one project folder as a whole word. */
function mentionsName(text: string, dir: string): boolean {
  const base = path.basename(dir);
  if (base.length < 2) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(base)}([^a-z0-9]|$)`, 'i').test(text);
}

export type ProjectMatch =
  | { kind: 'project'; choice: ProjectChoice; via: 'path' | 'token' | 'name' }
  | { kind: 'unknown'; name: string }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/** Resolve a leading project token, an explicit path, or a folder name. */
export function matchProject(text: string, choices: ProjectChoice[]): ProjectMatch {
  const dollar = DOLLAR_TOKEN.exec(text);
  if (dollar) {
    const name = dollar[1];
    const token = name.toLowerCase();
    const hit = choices.find((choice) => choice.token === token)
      ?? choices.find((choice) => choice.token === token.replace(TRAILING_PUNCTUATION, ''));
    if (hit) return { kind: 'project', choice: hit, via: 'token' };
    return { kind: 'unknown', name };
  }

  const explicit = findExplicitPath(text);
  if (explicit) {
    const resolved = canonicalDir(expandHome(explicit.path));
    const owner = choices.find((choice) => insideDir(resolved, choice.path));
    if (owner) return { kind: 'project', choice: owner, via: 'path' };
    return { kind: 'unknown', name: explicit.path };
  }

  const hits = choices.filter((choice) => mentionsName(text, choice.path));
  if (hits.length === 1) return { kind: 'project', choice: hits[0], via: 'name' };
  if (hits.length > 1) return { kind: 'ambiguous' };
  return { kind: 'none' };
}

/** Keep the task behind an unavailable explicit project reference. */
export function taskAfterUnknownProject(text: string): string {
  if (DOLLAR_TOKEN.test(text)) return text.replace(DOLLAR_TOKEN, '').trim();
  const explicit = findExplicitPath(text);
  return explicit ? withoutPath(text, explicit) : text.trim();
}

function withoutPath(text: string, explicit: { index: number; length: number }): string {
  return `${text.slice(0, explicit.index)} ${text.slice(explicit.index + explicit.length)}`.trim();
}

/** The task text without a leading project token or project folder name. */
export function taskAfterProject(text: string, match: Extract<ProjectMatch, { kind: 'project' }>): string {
  const { choice: { path: projectPath }, via } = match;
  const base = path.basename(projectPath);
  const trimmed = text.trim();
  if (via === 'token') return trimmed.replace(DOLLAR_TOKEN, '').trim();
  if (via === 'path') {
    const explicit = findExplicitPath(trimmed);
    if (!explicit) return trimmed;
    return withoutPath(trimmed, explicit);
  }
  const name = new RegExp(`^${escapeRegExp(base)}(?![\\w.-])[\\s,:;-]*`, 'i').exec(trimmed);
  return name ? trimmed.slice(name[0].length).trim() : trimmed;
}

/** Storage key prefix for every coding session of one thread. */
export function sessionKeyPrefix(threadId: string): string {
  return `${threadId}\n`;
}

/** Storage key for one coding session. One thread owns one session per project. */
export function sessionKey(threadId: string, projectPath: string): string {
  return `${sessionKeyPrefix(threadId)}${path.resolve(projectPath)}`;
}

