// Project routing for harness runs.
//
// One Muse conversation can own many coding sessions, one per project.
// These pure helpers pick the project for one task. The backend enforces
// the allowlist. A routing agent can call the same logic through the MCP
// server in `server/router-mcp.ts`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ProjectRegistry {
  projects: string[];
  discoveryRoot: string;
}

export interface ProjectResolution {
  projectPath: string;
  confidence: 'map-hit' | 'match' | 'single-root';
}

const PROJECT_LIMIT = 200;
const PATH_TOKEN = /(~\/[^\s:'"]+|\/[^\s:'"]+)/g;

export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveOne(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(expandHome(trimmed));
}

/** Normalize registry paths to absolute entries. Extra entries are dropped. */
export function resolveRegistryPaths(discoveryRoot: string, projects: string[]): ProjectRegistry {
  const seen = new Set<string>();
  for (const entry of projects) {
    const resolved = resolveOne(entry);
    if (resolved) seen.add(resolved);
    if (seen.size >= PROJECT_LIMIT) break;
  }
  return { projects: [...seen], discoveryRoot: path.resolve(expandHome(discoveryRoot)) };
}

export function insideDir(target: string, root: string): boolean {
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

/** Canonical form for stored paths. Missing paths stay resolved but unresolved. */
export function canonicalDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** True when the backend may launch a harness in this directory. */
export function isAllowedProject(target: string, registry: ProjectRegistry, fallbackCwd: string): boolean {
  const resolved = path.resolve(expandHome(target));
  if (insideDir(resolved, path.resolve(fallbackCwd))) return true;
  if (insideDir(resolved, registry.discoveryRoot)) return true;
  return registry.projects.some((root) => insideDir(resolved, root));
}

/** Storage key for one coding session. One Muse thread can own many. */
export function sessionKey(threadId: string, projectPath: string): string {
  return `${threadId}\n${path.resolve(projectPath)}`;
}

/** Project paths with sessions in one Muse thread, most recent last. */
export function threadProjects(sessions: Record<string, string>, threadId: string): string[] {
  const prefix = `${threadId}\n`;
  const found: string[] = [];
  for (const key of Object.keys(sessions)) {
    if (key.startsWith(prefix)) found.push(key.slice(prefix.length));
  }
  return found;
}

/** Find an explicit filesystem path in the task text. */
export function findExplicitPath(task: string): string | null {
  const match = task.match(PATH_TOKEN);
  if (!match) return null;
  const cleaned = match[0].replace(/[.,;:!?)]+$/, '');
  return cleaned.length > 1 ? cleaned : null;
}

function basenameLower(dir: string): string {
  return path.basename(dir).toLowerCase();
}

/**
 * Pick the project for one task. Return null when the task needs a question.
 * An explicit path wins. One basename hit wins. A known thread project wins.
 * The caller canonicalizes the answer and enforces the allowlist.
 */
export function resolveProject(
  task: string,
  threadKnown: string[],
  candidates: string[],
): ProjectResolution | null {
  const normalized = task.toLowerCase();
  const explicit = findExplicitPath(task);
  if (explicit) {
    const resolved = path.resolve(expandHome(explicit));
    const root = candidates.find((dir) => insideDir(resolved, dir));
    return { projectPath: root ?? resolved, confidence: 'match' };
  }
  const hits = candidates.filter((dir) => {
    const base = basenameLower(dir);
    return base.length > 1 && normalized.includes(base);
  });
  if (hits.length === 1) return { projectPath: hits[0], confidence: 'match' };
  if (hits.length > 1) return null;
  if (threadKnown.length > 0) return { projectPath: threadKnown[threadKnown.length - 1], confidence: 'map-hit' };
  if (candidates.length === 1) return { projectPath: candidates[0], confidence: 'match' };
  return null;
}

/** Immediate subdirectories of the discovery root, plus registered projects. */
export function listCandidates(registry: ProjectRegistry): string[] {
  const seen = new Set(registry.projects.map((dir) => path.resolve(dir)));
  try {
    for (const entry of fs.readdirSync(registry.discoveryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      seen.add(path.join(registry.discoveryRoot, entry.name));
      if (seen.size >= PROJECT_LIMIT) break;
    }
  } catch { /* a missing discovery root means no candidates */ }
  return [...seen];
}

/** Ask the user to name a project. The text never carries a harness mention. */
export function clarificationText(candidates: string[], threadKnown: string[]): string {
  const names = [...new Set([...threadKnown, ...candidates])]
    .map((dir) => path.basename(dir))
    .filter(Boolean)
    .slice(0, 8);
  const known = names.length ? ` Known projects: ${names.join(', ')}.` : '';
  return `Which project is this task for?${known} Name the project and repeat the task.`;
}
