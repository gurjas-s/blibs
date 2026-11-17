/* global process, console, URL */
// Generate the blibs app icons from assets/icon.svg.
//
// Run this file on macOS with `npm run icons`. It needs no image package:
// macOS renders the SVG with `sips`, and `iconutil` packs the .icns. The PNG
// output is committed, so Linux and Windows use the same files and never run
// this step. This file sits next to the source and the output that it owns.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ASSETS = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(ASSETS, 'icon.svg');
const ICON_DIR = path.join(ASSETS, 'icons');
const ICNS = path.join(ASSETS, 'blibs.icns');
const FAVICON = path.join(ASSETS, '..', 'public', 'favicon.svg');

// Every size that the app or a packager asks for: window icon, tray icon,
// dock icon, and the .icns set.
const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

// The .icns entries and the PNG size that each one needs.
const ICNSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Run `npm run icons` on macOS. The committed PNG and .icns files are enough on other systems.');
  }
  mkdirSync(ICON_DIR, { recursive: true });
  for (const size of SIZES) {
    // Each size is a direct scale of the SVG, not a scale of another PNG.
    run('sips', ['-s', 'format', 'png', '-z', String(size), String(size), SOURCE, '--out', path.join(ICON_DIR, `${size}.png`)]);
    console.log(`assets/icons/${size}.png`);
  }

  const work = mkdtempSync(path.join(tmpdir(), 'blibs-icon-'));
  const iconset = path.join(work, 'blibs.iconset');
  mkdirSync(iconset);
  try {
    for (const [name, size] of ICNSET) {
      copyFileSync(path.join(ICON_DIR, `${size}.png`), path.join(iconset, name));
    }
    run('iconutil', ['-c', 'icns', iconset, '-o', ICNS]);
    console.log('assets/blibs.icns');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  copyFileSync(SOURCE, FAVICON);
  console.log('public/favicon.svg');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
