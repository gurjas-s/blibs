# blibs desktop (Electron shell)

One app window: the blibs panel + three persistent vendor sessions
(`muse.ai`, `chatgpt.com`, `grok.com`). Nothing needs to be open in your
browser — the hidden views stay alive inside the app, logged in, syncing.

## Run (on your Mac)

```bash
# repo root first (one time):
npm install && npm run build

cd desktop
npm install
npm start
```

Then **Agents → Log in to Muse / Dots / Grok** (once each). The login window
shares cookies with the hidden sync view, so after login you can close it —
syncing continues in the background.

## How it works

- `main.js` spawns `server/proxy.mjs` (`:8787`) and serves the built panel
  (`../dist`, requires `npm run build`) on `:5174`, forwarding `/api/*`.
- One hidden `BrowserView` per vendor (`persist:*` partitions, login survives
  restarts) runs `preload-agent.js`: same scrape/send/auto-push protocol as
  the browser extension, over IPC instead of `chrome.*`.
- 60s collect sweep + 30s outbox drain; every scrape also triggers a drain,
  so sends typically land within seconds.
- `npm run smoke` (`electron . --blibs-smoke`): boots headless-ish, prints a
  JSON status line, quits non-zero on failure. Needs a display.

## Files

| File | What |
|---|---|
| `main.js` | lifecycle, proxy+static servers, views, menu, outbox loop |
| `preload-agent.js` | per-view scrape/send (ported from `extension/content.js`) |
| `package.json` | `electron` devDependency, `start` / `smoke` scripts |

## Limits

Same as the extension (DOM fragility, login expiry, personal-use ToS), minus
the open-tabs burden. `npm test` runs the headless harness (stubs Electron,
boots the real proxy + panel server, drives the outbox/import loop with fake
views) — GUI rendering itself needs a real display to verify.
