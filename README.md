# blibs — one desktop app for your personal agents

[![CI](https://github.com/gurjas-s/blibs/actions/workflows/ci.yml/badge.svg)](https://github.com/gurjas-s/blibs/actions/workflows/ci.yml)

blibs is a desktop control panel for **personal agents** — the always-on,
action-taking kind (Meta **Muse**, OpenAI **Dots**, xAI **Grok**), not plain chatbots.
Chat with all three from one window, and reply from blibs straight into the real agent session.

There is no public chat-history or send API for any of these consumer products
(verified Oct 2026), and all three block iframing (`X-Frame-Options: SAMEORIGIN` /
`DENY`). So blibs keeps three persistent vendor sessions alive inside the app
itself — logged in, syncing — with a tiny local backend as the middleman.

```
muse.ai / chatgpt.com / grok.com (persistent sessions inside the app)
        ↕  built-in views read chats, type your replies
http://127.0.0.1:8787  local backend  (import store + send outbox)
        ↕  /api/imports, /api/outbox*
blibs panel (Electron + React, served from inside the app on :5174)
```

## First run (new developer)

Prerequisites: Node.js 24 (`node -v`). No browser setup needed — sessions live in the app.

```bash
npm install        # install everything (one package — see note below if Electron misbehaves)
npm run build      # typecheck + compile + bundle the panel
npm start          # launch the desktop app
```

Then **Agents → Log in to Muse / Dots / Grok** (once each). The login window
shares cookies with the hidden sync view, so after login you can close it —
syncing continues in the background.

You can also select **Sign in** beside an agent in the panel. blibs checks saved
sessions on startup and shows each agent's connection state. If a session
expires, saved chats stay available and queued replies wait for sign-in.
Complete any required password or verification step in the vendor's sign-in
window. Repeated sign-in requests focus the same window.

> **If `npm start` fails with `Electron failed to install correctly`:** npm ≥ 11
> gates install scripts, so Electron's binary download never ran. Fix:
>
> ```bash
> npm install-scripts approve electron
> rm -rf node_modules/electron
> npm install
> ```
>
> If `node_modules/electron/dist/` is afterwards still just
> `LICENSES.chromium.html` (the old `extract-zip` stalls on newer Node), unzip the
> already-downloaded binary by hand:
>
> ```bash
> unzip -q -o ~/Library/Caches/electron/*/electron-v34.5.8-darwin-arm64.zip \
>   -d node_modules/electron/dist/
> printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
> ```

Chats flow in automatically: the app pushes seconds after chat content changes
(plus a 1-minute backup sweep), and the panel auto-pulls every 15s
(checkbox + interval in the sidebar).

**Send from blibs:** type in the composer, hit Send. The message is queued on the
backend, the app types it into the matching session and sends it, and the badge
under your message flips `Sending…` → `Sent` (or `Not delivered` + Retry).
The agent's reply syncs back on its own.

Use **Enter** to send and **Shift+Enter** for a new line. Each message shows
**Queued**, **Sent**, or **Not sent**. Select **Retry** on a failed message;
retrying a queue request does not create a second send. Delivery status keeps
updating when automatic chat sync is off. Vendor delivery is confirmed when the
composer clears after sending; this does not guarantee the vendor's server has
finished processing the message.

Messages retain line breaks and fenced code blocks. New replies keep your
reading position; select **New messages** to jump to the latest reply.

## Scripts

| Command | What |
|---|---|
| `npm run build` | Full build: `tsc` (main + preload as CJS, backend as ESM) → CJS markers → Vite bundles the panel to `dist/` |
| `npm start` | Launch the app (needs a prior `build`) |
| `npm test` | Rebuilds, runs unit and HTTP route tests, then runs the desktop harness with temporary stores and ports |
| `npm run smoke` | Boots the real app window, prints a JSON status line, quits — needs a display |
| `npm run lint` | `oxlint` over the repo |
| `npm run clean` | Wipe `build/` + `dist/` (then `build` again) |
| `npm run verify:clean-build` | Delete generated output, rebuild with the existing incremental cache, and check that all required output was regenerated |

CI runs on Linux and Windows for every push and pull request. To block merging
when checks fail, a repository admin must require both **Build, lint, and test**
checks in the default branch's protection rules. See `AGENTS.md` for contribution guidance.

## Repo layout

Standard Electron + Vite structure — one process per directory:

```
src/
  main/         main process (Node + Electron APIs, no DOM)
    index.ts        app lifecycle, backend + panel servers, vendor views,
                    menu, outbox loop, 60s sweep / 30s drain timers
    test-harness.ts headless tests (npm test)
  preload/      bridge scripts (DOM + limited Electron IPC, no Node UI code)
    agent.ts        scrape + send; injected into every vendor session
  renderer/     React UI (DOM only — bundled by Vite into dist/)
    App.tsx         agent list, threads, composer, auto-pull
    main.tsx        React entry (loaded by index.html)
    providers.ts    the three vendors — the seam for future native APIs
    types.ts        Agent / ChatMessage
    *.css, assets/ theme + static assets
server/
  proxy.ts      local backend (plain Node HTTP, zero deps): chat fan-out,
                import store, send outbox. Spawned by the main process.
scripts/
  emit-cjs-markers.mjs  build step — see "Modules" below
```

Generated, never edited or committed: `build/` (compiled main/preload/backend),
`dist/` (bundled panel), `node_modules/`. The desktop app stores runtime data in
the `chats` directory under Electron's user data directory. Tests set
`BLIBS_DATA_DIR` to a temporary directory. Panel state lives in
`localStorage` (`blibs-messages-v2`, `blibs-agents-v2`, …) — swap for a DB + OAuth
in production.

## Modules (read this before touching the build)

The root is `"type": "module"`, but Electron's main process and preload scripts
must load as **CommonJS**, while the backend stays **ESM**. This is handled by
tiny marker files the build regenerates — `build/main/package.json` and
`build/preload/package.json`, each containing `{"type":"commonjs"}`:

- `tsc -b --force` compiles `src/main` + `src/preload` (CJS) and `server` (ESM).
  `--force` matters: without it, `tsc -b` trusts stale incremental state and can
  silently skip emitting after `build/` is deleted.
- `scripts/emit-cjs-markers.mjs` writes the markers.
- `vite build` bundles `src/renderer` to `dist/`.

Symptoms if you get this wrong: `exports is not defined in ES module scope`
at `build/main/index.js` on `npm start` means the markers are missing — just
re-run `npm run build`.

## Backend API (internal, app ↔ panel)

| Endpoint | Who | What |
|---|---|---|
| `GET /api/health` | anyone | `{"ok":true}` — is the backend up? |
| `POST /api/import` | views | push scraped chats `{items:[{provider,role,text,ts?,url?}]}` (deduped) |
| `GET /api/imports` | panel | last 500 stored chats |
| `POST /api/outbox` | panel | enqueue a reply `{provider,text}` → `{id}` |
| `GET /api/outbox/pending` | main | oldest queued sends |
| `POST /api/outbox/ack` | main | confirm delivery `{id,ok,error?}` |
| `POST /api/outbox/retry` | panel | requeue a failed send |
| `GET /api/outbox` | panel | delivery statuses (drives the Sent/failed badges) |
| `POST /api/chat` | panel | BYOK model fan-out (legacy route, kept for API use) |

Ports: backend `:8787` (`PROXY_PORT`), panel `:5174` (`BLIBS_UI_PORT`). The panel
server forwards `/api/*` to the backend — the same mapping `vite.config.ts`
declares for reference.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '…/build/main/index.js'` on `npm start` | You skipped the build — run `npm run build` first (`build/` is generated) |
| `exports is not defined in ES module scope` | CJS markers missing — re-run `npm run build` |
| `Electron failed to install correctly` | Approve + reinstall Electron (see First run) |
| Weird behavior right after `npm start` | Make sure `ELECTRON_RUN_AS_NODE` is **not** exported in your shell (`unset` it and remove it from `~/.zshrc` — it makes Electron act as plain Node) |
| Blibs: `Backend unreachable` pill | Backend didn't boot with the app — restart; check the terminal for `[blibs] proxy exited` |
| `EADDRINUSE` on `:5174`/`:8787` in `npm test` | A previous app instance is still running — quit it first |
| Message stays `Queued` | Check the agent's sign-in status. Sign in or open its conversation to resume sending. |
| Message shows `Not sent` | Read the reason below the message, then select **Retry**. |
| Login lost after restart | Partitions persist per OS user; check you didn't clear app data |

## Limits (honest POC notes)

- Only sees what's rendered in the **logged-in in-app sessions**. Mobile apps
  and WhatsApp/Slack DMs are out of reach.
- Sending is best-effort DOM automation (fill composer → click send); vendors
  redesign pages, selectors need maintenance — failures always surface with a reason.
- Personal use on your own accounts; check vendor ToS before productizing.
