// Default projects directory.
//
// A fresh install reads projects from the shared Projects folder. The relay
// still accepts a directory from the panel or the local API, and the saved
// state wins after the first run. Only the immediate subfolders are projects.
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DISCOVERY_ROOT = path.join(os.homedir(), 'Projects');
export const DEFAULT_RELAY_MODEL = 'opencode-go/beam-free';
