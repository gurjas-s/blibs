# First-run reproduction (macOS)

Checked against `origin/master` (`e467f99`) plus the onboarding fix, from a fresh
clone of `fix/onboarding-first-run`.

Environment:

- macOS (arm64)
- Node.js v24.22.3 (`fnm use 24`; the default shell Node.js v26.9.0 cannot
  install Electron 34, and the new postinstall check explains that)
- npm 11.19.1

## Commands and output

```text
$ npm ci

> blibs@0.1.0 postinstall
> node scripts/check-electron.mjs

added 101 packages, and audited 102 packages in 2s
...
npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn install-scripts   fsevents@2.3.3 (install: (install scripts present))
EXIT:0
```

The `fsevents` warning is optional native file watching; Electron installs.

```text
$ npm run build

> blibs@0.1.0 build
> tsc -b --force && node scripts/emit-cjs-markers.mjs && vite build

wrote build/main/package.json + build/preload/package.json (type: commonjs)
vite v8.3.2 building client environment for production...
✓ 20 modules transformed.
dist/index.html                   0.48 kB │ gzip:  0.31 kB
dist/assets/index-C2lka0hy.css    8.30 kB │ gzip:  2.36 kB
dist/assets/index-DL1s1llG.js   235.47 kB │ gzip: 73.81 kB
✓ built in 352ms
EXIT:0
```

```text
$ npm start

> blibs@0.1.0 prestart
> node scripts/check-electron.mjs

> blibs@0.1.0 start
> electron .

DevTools listening on ws://127.0.0.1:9222/devtools/browser/...
blibs proxy on http://127.0.0.1:8787
[blibs] panel on http://127.0.0.1:5174
EXIT: still running; quit cleanly after the checks below
```

Health check through the panel server:

```text
$ curl -i http://127.0.0.1:5174/api/health
HTTP/1.1 200 OK
Content-Type: application/json

{"ok":true}
```

The panel loaded with an empty first-run state and no vendor sign-in. See
`panel.png`. The log contained no uncaught main-process errors on boot. Chromium
printed `ffmpeg_common.cc` pixel-format messages and one `sysctlbyname` message;
these do not affect the window or the backend.

`npm run lint` and `npm test` also passed in the fresh clone (22 tests and the
desktop harness).

## Install check on the default Node.js release

With Node.js v26.9.0, Electron 34's installer exits 0 but leaves only
`node_modules/electron/dist/LICENSES.chromium.html`. The new postinstall check
turns that silent failure into:

```text
[blibs] Electron is not installed correctly.
        Current Node.js: v26.9.0. blibs requires Node.js 24.x.
        Electron 34 does not install its binary on newer Node.js releases.
        Switch to Node.js 24 and reinstall:
          fnm use 24 && npm ci      # or: nvm use 24 && npm ci
        Then run npm start again.
```
