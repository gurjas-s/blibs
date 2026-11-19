// Default relay registry.
//
// A fresh install starts with the shared Projects folder and two known
// projects. The relay still accepts a registry from the panel or the local
// API, and the saved state wins after the first run. Keep this list small:
// every entry becomes an allowed project directory.
import os from 'node:os';
import path from 'node:path';

/** Folder whose subdirectories are project candidates. */
export const DEFAULT_DISCOVERY_ROOT = path.join(os.homedir(), 'Projects');

/** Approved projects for a fresh install. */
export const DEFAULT_PROJECTS = [
  path.join(DEFAULT_DISCOVERY_ROOT, 'LeetCode-Solutions'),
  path.join(DEFAULT_DISCOVERY_ROOT, 'streaming-simulator'),
];
