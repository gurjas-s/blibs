# blibs — one desktop app for your personal agents

[![CI](https://github.com/gurjas-s/blibs/actions/workflows/ci.yml/badge.svg)](https://github.com/gurjas-s/blibs/actions/workflows/ci.yml)

blibs is a desktop control panel for **personal agents** — the always-on,
action-taking kind (Meta **Muse**, OpenAI **Dots**, xAI **Grok**), not plain chatbots.

blibs connects each assistant to the local coding harnesses on your computer
(**Claude Code**, **Codex**, **OpenCode**). You select the harnesses for each
assistant one time. You also select the shared folder that the harnesses may
read and write. Chat with all three assistants from one window, and reply from
blibs straight into the real assistant session.

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

Prerequisites: Node.js 24.x (`node -v` must print `v24.…`). Electron 34's
installer does not work on newer Node.js releases, so switch to Node 24 before
installing (`fnm use 24` or `nvm use 24`). No browser setup needed — sessions
live in the app.

```bash
npm ci             # install the exact dependency versions in package-lock.json
npm run build      # typecheck + compile + bundle the panel
npm start          # launch the desktop app
```

`npm ci` fails with an actionable message if Electron's binary is missing,
rather than letting `npm start` fail later with `Electron failed to install
correctly`. After changing `package-lock.json`, use `npm install` locally and
commit the updated lockfile; everyone else and CI use `npm ci`.

The first start opens the **Connections** screen. It shows one row for each
local harness and one column for each assistant. Turn on the harnesses that each
assistant can use. Set the shared folder. Select **Start chatting**.

Select **Connect another assistant** on the Connections screen to sign in to
Muse, Dots, or Grok (once each). The **Agents** item in the sidebar and the
**Agents** menu are other paths to the same screen. The sign-in window shares
cookies with the hidden sync view, so after sign-in you can close it — syncing
continues in the background. If the vendor asks for a mobile code or a CAPTCHA,
the agents screen shows that step. Select **Check again** after you complete it.
**Back to chats**, **Cancel**, and **Escape** always return to the panel.

An assistant with no signed-in session shows a setup card in its chat. The card
lists the steps, gives the connect link, and offers **Check connection** and
**Open assistant**. The composer stays disabled until the assistant is
connected. Select **Connections** in the sidebar to change the harnesses or the
folder later.

> **If npm blocks Electron's install script:** approve it, then reinstall:
>
> ```bash
> npm install-scripts approve electron
> npm ci
> ```
>
> Some Node.js and npm versions can leave `node_modules/electron/dist/`
> with only `LICENSES.chromium.html`. Check that `node -v` prints `v24.…` and
> that `node_modules/electron/path.txt` exists; delete `node_modules` and run
> `npm ci` again if it does not.

Chats flow in automatically: the app pushes seconds after chat content changes
(plus a 1-minute backup sweep), and the panel auto-pulls every 15s by default.
The Auto-sync toggle and interval are in Settings.

**Send from blibs:** type in the composer, hit Send. The message is queued on the
backend, the app types it into the matching session and sends it, and the badge
under your message flips `Sending…` → `Sent` (or `Not delivered` + Retry).
The agent's reply syncs back on its own.

## Scripts

| Command | What |
|---|---|
| `npm run build` | Full build: `tsc` (main + preload as CJS, backend as ESM) → CJS markers → Vite bundles the panel to `dist/` |
| `npm start` | Launch the app (needs a prior `build`) |
| `npm test` | Rebuilds, runs unit and HTTP route tests, then runs the desktop harness with temporary stores and ports |
| `npm run e2e` | Builds, starts the real Electron app with a remote debugging port, and runs the smoke spec over CDP; needs a display |
| `npm run test:desktop` | Tests search and citations in an isolated Electron renderer after building; needs a display, but no model downloads |
| `npm run smoke` | Boots the real app window, prints a JSON status line, quits — needs a display |
| `npm run lint` | ESLint flat config over `src/`, `server/`, `scripts/`, and `tests/` (fails on warnings) |
| `npm run icons` | Regenerate the app PNG sizes, the macOS `.icns`, and the panel favicon from `assets/icon.svg`; needs macOS |
| `npm run clean` | Wipe `build/` + `dist/` |
| `npm run verify:clean-build` | Delete generated output, rebuild with the existing incremental cache, and check that all required output was regenerated |

CI runs on Linux and Windows for every push and pull request. To block merging
when checks fail, a repository admin must require both **Build, lint, and test**
checks in the default branch's protection rules. See `AGENTS.md` for contribution guidance.

## App icon and packaging

`assets/icon.svg` is the icon source. It is flat and uses one accent color. The
committed files below are generated from it:

- `assets/icons/16.png` to `assets/icons/1024.png`
- `assets/blibs.icns` for macOS
- `public/favicon.svg` for the panel tab

Run `npm run icons` on macOS after you change the source. The command uses
`sips` and `iconutil`, so it needs no extra package. Linux and Windows use the
committed files and do not run the command.

At runtime `src/main/index.ts` sets the app name to `blibs`, builds the
application menu and the About item with that name, sets the Dock icon from
`assets/icons/1024.png`, and sets the window icon from `assets/icons/512.png`
where the platform shows one.

The repository has no packager, so the app runs from the checkout. To build an
installer, add a packager and then:

- Set the product name and the executable name to `blibs`.
- Copy `assets/` into the app resources. The main process reads
  `process.resourcesPath/assets` when `app.isPackaged` is true.
- Set `assets/blibs.icns` as `CFBundleIconFile` on macOS.
- Set the app id to `com.blibs.app`, to match `app.setAppUserModelId` on
  Windows.

## End-to-end tests

`npm run e2e` builds the app and runs a smoke spec in the real Electron app. The
harness starts Electron with `--remote-debugging-port` on a free port. It
connects `playwright-core` over the Chrome DevTools Protocol (CDP). It uses the
Chromium engine inside Electron, so it does not download a browser.

The harness starts the app with a temporary profile and history directory. It
uses free ports for the panel and the backend. It needs no vendor login.

The smoke spec verifies these items:

- The panel window loads.
- The backend answers `/api/health` through the panel proxy and directly.
- The panel reports a successful import pull.
- The sidebar shows a selected chat and the narrow layout collapses.
- The connected chat shows a harness action card and the context column.
- The context column becomes an overlay at 1024 pixels and stays reachable.
- Settings holds the Auto-sync toggle and interval, and the sidebar footer
  keeps only the Agents entry.
- The topbar search runs one global search, a provider tag limits it, and
  Settings holds the index controls and the theme.
- The message thread shows roles, timestamps, and wrapped long text.
- The theme control follows the system preference and saves the choice.
- The layout has no horizontal scroll at 1024 and 1440 pixels.
- The first-run connections screen shows the harness matrix, changes the shared
  folder, starts the chat, and stays complete after a reload.
- An unconnected assistant shows the inline setup card and a disabled composer.
- The agents screen is the in-app sign-in entry point.
- A mocked sign-in shows progress, a mobile verification step, and Cancel.
- Escape and Back return to the home screen after a mocked sign-in.

The spec writes light and dark screenshots to
`tests/e2e/artifacts/panel-dark.png` and
`tests/e2e/artifacts/panel-light.png`. It also writes the connections screen, the
connected chat, the setup chat, and the sign-in screenshots. The repository
ignores this directory. The screenshots use mock chats, mock connection state,
and mocked sign-in steps, not a vendor login.

The reusable module is `tests/e2e/harness.ts`. It exports `launch`,
`waitForPanel`, `screenshot`, `selectAgent`, `selectTheme`, `setTheme`,
`seedChats`, `resetOnboarding`, `completeOnboarding`, `seedConnections`,
`mockConnections`, and `CONNECTIONS_STORAGE_KEY`. `seedConnections` writes mock
connection state, so a test can select a connected or unconnected assistant. The
harness starts the app with `BLIBS_MOCK_LOGIN=1`, so a sign-in attempt uses fixed
mock steps. Add a new spec in `tests/e2e/` to test another feature.

The check needs a display. macOS and Windows use the desktop session. On Linux
without `DISPLAY` or `WAYLAND_DISPLAY`, the spec skips with a clear message. Use
`xvfb-run -a npm run e2e` on a headless Linux machine. `npm test` does not run
the e2e check.

## Contributing

Read `AGENTS.md` before you change code. The repository skills in
`.agents/skills/` hold the repeatable steps:

- `onboarding` — set up a fresh checkout and start the app.
- `design` — add UI with the component layer and design tokens.
- `validate` — run the build, lint, unit tests, one manual test, and add a
  screenshot when the change is visible.

Write PR titles, PR descriptions, review comments, and user-facing docs in
English. Use ASD-STE100 Simplified Technical English.

## Repo layout

Standard Electron + Vite structure — one process per directory:

```
src/
  main/         main process (Node + Electron APIs, no DOM)
    index.ts        app lifecycle, backend + panel servers, vendor views,
                    menu, outbox loop, 60s sweep / 30s drain timers
    login.ts        vendor sign-in windows and inline step events
    test-harness.ts headless tests (npm test)
  preload/      bridge scripts (DOM + limited Electron IPC, no Node UI code)
    agent.ts        scrape + send; injected into every vendor session
    panel.ts        narrow sign-in bridge for the panel
  renderer/     React UI (DOM only — bundled by Vite into dist/)
    App.tsx         three-pane shell: assistants, chat, context column
    main.tsx        React entry (loaded by index.html)
    client.ts       the only typed data client for backend routes
    connections.ts  connection state, setup derivation, local storage
    desktop.ts      typed access to the panel preload bridge
    Onboarding.tsx  first-run connections screen and harness matrix
    LoginScreen.tsx agents screen and inline sign-in steps
    components/     reusable UI components with typed props
    styles/         design tokens (light + dark) and base styles
    SearchPanel.tsx results for the global search
    SettingsPanel.tsx sync, search defaults, index, answers, and theme
    search.ts       search parsing and persistent defaults
    providers.ts    the three vendors — the seam for future native APIs
    types.ts        Agent / ChatMessage / harness types
    *.css, assets/  layout, theme entry, static assets
server/
  proxy.ts      local backend (plain Node HTTP, zero deps): chat fan-out,
                import store, send outbox, and the relay route. Spawned by the
                main process.
  relay.ts      relay queue, durable high-water mark, and run state
  harness/      the Harness interface and the OpenCode adapter
tests/
  e2e/          real-app CDP harness (`harness.ts`) and smoke spec; run with
                `npm run e2e`
scripts/
  emit-cjs-markers.mjs  build step — see "Modules" below
assets/
  icon.svg       icon source (flat, one accent color)
  icons/         generated PNG sizes, 16 px to 1024 px
  blibs.icns     generated macOS bundle icon
  build-icons.mjs  generates the PNG sizes and the .icns (`npm run icons`)
.agents/
  skills/       repo skills for design, onboarding, and validation
```

Generated, never edited or committed: `build/` (compiled main/preload/backend),
`dist/` (bundled panel), `node_modules/`. Retained chats and the send outbox live
in `<Electron userData>/history`; `BLIBS_DATA_DIR` overrides that directory. See
[conversation search storage](docs/conversation-search.md) for migration details.
Panel state lives in `localStorage` (`blibs-messages-v2`, `blibs-agents-v2`,
`blibs-connections-v1`, `blibs-theme-v1`, …) — swap for a DB + OAuth in
production.

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
| `POST /api/import` | views | push scraped chats `{items:[{provider,role,text,ts?,url?,sourceId?,threadId?,identity?}]}` (repeatable source identity) |
| `GET /api/imports` | panel | last 500 stored chats |
| `GET /api/history?limit=100&offset=0` | panel | paginated retained SQLite history |
| `GET /api/history/:id` | panel | exact retained citation source |
| `POST /api/search` | panel | keyword/hybrid search with provider, thread, and date filters |
| `POST /api/ask` | panel | experimental local extractive answers with validated evidence quotes |
| `GET/POST /api/index` | panel | model/index status; resume, cancel, or rebuild vectors |
| `GET /api/relay` | panel | relay state, pending count, and the last run |
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
| `Electron failed to install correctly` | Use Node.js 24.x, approve Electron's install script if npm asks, then run `npm ci` (see First run) |
| Weird behavior right after `npm start` | Make sure `ELECTRON_RUN_AS_NODE` is **not** exported in your shell (`unset` it and remove it from `~/.zshrc` — it makes Electron act as plain Node) |
| Blibs: `Backend unreachable` pill | Backend didn't boot with the app — restart; check the terminal for `[blibs] proxy exited` |
| `EADDRINUSE` on `:5174`/`:8787` in `npm test` | A previous app instance is still running — quit it first |
| Send stuck on `Sending…` | Session not signed in or page still loading — use Agents, then Retry |
| Login lost after restart | Partitions persist per OS user; check you didn't clear app data |

## Limits (honest POC notes)

**Connections:** The harness choice, the shared folder, and the setup state are
local to this window. The app saves them in `localStorage`. The app does not
start a harness run, open the shared folder, or resolve the connect link yet.
The activity list and the chat action card appear only when a backend reports
work. Until then, the context column shows an honest empty state. The setup card
uses the saved login status for Muse, Dots, and Grok. A status change updates
the card and the assistant list.

**Conversation search:** Use the search bar in the topbar. It searches all
retained conversations after a short pause, and Enter runs the search at once.
Add a tag such as `#muse` to limit the search to one provider. Cmd+F on macOS or
Ctrl+F elsewhere focuses the bar. The sidebar gear opens Settings for the index
controls, **Ask locally**, the thread and date filters, and the theme. Keyword
search works without model setup. Optional free local BGE embeddings add semantic
retrieval, and a small local Qwen model can select cited evidence sentences.
Local answering is experimental: accurate quotes can still be irrelevant or
incomplete. Review the sources. Read [setup, migration, and test
instructions](docs/conversation-search.md) before enabling models. Runtime data
now lives in Electron's user-data history directory, with a preserved legacy
JSON backup; retained history is not capped at the panel's 500 messages.

- Only sees what's rendered in the **logged-in in-app sessions**. Mobile apps
  and WhatsApp/Slack DMs are out of reach.
- Sending is best-effort DOM automation (fill composer → click send); vendors
  redesign pages, selectors need maintenance — failures always surface with a reason.
- Personal use on your own accounts; check vendor ToS before productizing.
