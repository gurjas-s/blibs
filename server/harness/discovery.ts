// Bounded home-folder project search for the `$find-project` fallback.
//
// The relay and the router MCP server use the same search. The search is
// synchronous and bounded, so a large home folder cannot block a run for a
// long time. A directory with a project marker is one project. The scan does
// not enter that directory, so a monorepo counts once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DISCOVERY_DEPTH_LIMIT = 4;
export const DISCOVERY_DIR_LIMIT = 20_000;
export const DISCOVERY_PROJECT_LIMIT = 80;
export const DISCOVERY_TIME_LIMIT_MS = 2_500;

const PROJECT_DIRS = new Set(['.git', '.hg', '.svn']);
const PROJECT_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'Cargo.toml',
  'go.mod',
  'go.work',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'deno.json',
  'deno.jsonc',
  'flake.nix',
  'CMakeLists.txt',
  'Project.toml',
  'Package.swift',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  'library',
  'applications',
  'system',
  'volumes',
  'private',
  'tmp',
  'temp',
  'cache',
  'caches',
  'trash',
  'dist',
  'build',
  'target',
  'vendor',
  'pods',
  'deriveddata',
  'venv',
  'env',
  '__pycache__',
  'coverage',
  'out',
  'bin',
  'obj',
  'logs',
  'log',
]);

export interface DiscoveredProject {
  path: string;
  markers: string[];
}

export interface DiscoveryOptions {
  root?: string;
  maxDepth?: number;
  maxDirectories?: number;
  maxProjects?: number;
  timeLimitMs?: number;
}

export interface DiscoveryResult {
  root: string;
  projects: DiscoveredProject[];
  truncated: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isSkipped(name: string): boolean {
  if (name.startsWith('.')) return true;
  return SKIP_DIRS.has(name.toLowerCase());
}

/** Search the user home folder for directories with a project marker. */
export function searchHomeProjects(options: DiscoveryOptions = {}): DiscoveryResult {
  const root = path.resolve(options.root ?? os.homedir());
  const maxDepth = clamp(options.maxDepth ?? DISCOVERY_DEPTH_LIMIT, 0, 12);
  const maxDirectories = clamp(options.maxDirectories ?? DISCOVERY_DIR_LIMIT, 1, 100_000);
  const maxProjects = clamp(options.maxProjects ?? DISCOVERY_PROJECT_LIMIT, 1, 200);
  const timeLimitMs = clamp(options.timeLimitMs ?? DISCOVERY_TIME_LIMIT_MS, 100, 10_000);
  const deadline = Date.now() + timeLimitMs;
  const projects: DiscoveredProject[] = [];
  const seen = new Set<string>();
  let visited = 0;
  let truncated = false;

  const visit = (dir: string, depth: number): void => {
    if (projects.length >= maxProjects || visited >= maxDirectories || Date.now() > deadline) {
      truncated = true;
      return;
    }
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const markers: string[] = [];
    const children: string[] = [];
    for (const entry of entries) {
      if (PROJECT_DIRS.has(entry.name) && (entry.isDirectory() || entry.isFile())) {
        markers.push(entry.name);
        continue;
      }
      if (PROJECT_FILES.has(entry.name) && entry.isFile()) {
        markers.push(entry.name);
        continue;
      }
      if (!entry.isDirectory() || isSkipped(entry.name)) continue;
      children.push(entry.name);
    }
    if (markers.length) {
      const resolved = path.resolve(dir);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        projects.push({ path: resolved, markers });
      }
      return;
    }
    if (depth >= maxDepth) return;
    for (const name of children) visit(path.join(dir, name), depth + 1);
  };

  visit(root, 0);
  projects.sort((a, b) => a.path.localeCompare(b.path));
  return { root, projects: projects.slice(0, maxProjects), truncated };
}
