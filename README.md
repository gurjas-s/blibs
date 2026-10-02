# blibs — one panel for your personal agents

blibs is a proof-of-concept control panel for **personal agents** — the always-on,
action-taking kind (Meta **Muse**, OpenAI **Dots**, xAI **Grok**), not plain chatbots.
Chat with all three from one UI, and reply from blibs straight into the real agent tab.

There is no public chat-history or send API for any of these consumer products
(verified Oct 2026), and all three block iframing (`X-Frame-Options: SAMEORIGIN` /
`DENY`). So blibs syncs through a **companion browser extension** that runs in your
own logged-in tabs, with a tiny local proxy as the middleman.

```
muse.ai / chatgpt.com / grok.com (your logged-in tabs)
        ↕  extension reads chats, types your replies
http://…:8787  server/proxy.mjs  (import store + send outbox)
        ↕  /api/imports, /api/outbox*
http://…:5173  blibs panel (Vite + React)
```

## Prerequisites

- Node.js 20+ (`node -v`)
- A Chromium browser (Chrome / Edge / Brave) for the extension

## Setup

```bash
git clone git@github.com:<you>/blibs.git
cd blibs
npm install
```

**Terminal 1 — backend (required):**

```bash
npm run proxy
# blibs proxy on http://localhost:8787
```

**Terminal 2 — frontend:**

```bash
npm run dev
# open http://localhost:5173
```

**Extension (one time):**

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/`.
2. Open + log in to `https://muse.ai`, `https://chatgpt.com`, `https://grok.com` (pinned tabs work best).
3. **Reload each vendor tab** after installing (content scripts only enter pages loaded post-install).
4. Click the ◍ icon → per-tab **Sync**. The result box shows exactly what happened
   (`collected: N`, selector used, or the error).

Chats flow in automatically from there: the extension pushes ~seconds after chat
content changes (plus a 1-minute backup sweep, configurable in the popup), and
blibs auto-pulls every 15s (checkbox + interval in the sidebar).

**Send from blibs:** type in the composer, hit Send. The message is queued on the
proxy, the extension types it into the matching tab and sends it, and the badge
under your message flips `Sending…` → `Sent` (or `Not delivered` + Retry).
The agent's reply syncs back on its own.

## Same machine vs split setup

The extension and the panel must talk to the **same** proxy:

- **Everything on one machine** (recommended): defaults just work.
- **Browser on one machine, code on another** (e.g. Mac browser + Linux VM):
  point the extension at the proxy via the popup's **proxy host** field
  (`<vm-ip>:8787`, Save), or forward port 8787 to the VM like you do for 5173.

## Desktop app (no browser tabs needed)

`desktop/` is an Electron shell: the panel plus three persistent vendor
sessions in one window. Run on your Mac:

```bash
npm install && npm run build   # repo root, one time
cd desktop && npm install && npm start
```

Then **Agents → Log in** once per vendor. Details in `desktop/README.md`.

## Repo layout

| Path | What |
|---|---|
| `src/App.tsx` | Whole panel: agent list, threads, composer, auto-pull |
| `src/App.css`, `src/index.css` | Flat slate theme (one accent, no gradients) |
| `src/providers.ts` | The three real products (names/URLs) — the seam for future native APIs |
| `src/types.ts` | `Agent` / `ChatMessage` |
| `server/proxy.mjs` | Zero-dependency local backend: chat fan-out, import store, send outbox |
| `extension/` | Manifest V3 companion (one machine: browser + proxy colocated) |
| `desktop/` | Electron shell (persistent sessions, no browser tabs needed) |

## Proxy API

| Endpoint | Who | What |
|---|---|---|
| `GET /api/health` | anyone | `{"ok":true}` — is the proxy up? |
| `POST /api/import` | extension | push scraped chats `{items:[{provider,role,text,ts?,url?}]}` (deduped) |
| `GET /api/imports` | panel | last 500 stored chats |
| `POST /api/outbox` | panel | enqueue a reply `{provider,text}` → `{id}` |
| `GET /api/outbox/pending` | extension | oldest queued sends |
| `POST /api/outbox/ack` | extension | confirm delivery `{id,ok,error?}` |
| `POST /api/outbox/retry` | panel | requeue a failed send |
| `GET /api/outbox` | panel | delivery statuses (drives the Sent/failed badges) |
| `POST /api/chat` | panel | BYOK model fan-out (legacy route, kept for API use) |

Runtime data (`server/imports.json`, `server/outbox.json`) is gitignored and
recreated on demand. Panel state lives in `localStorage` (`blibs-messages-v2`,
`blibs-agents-v2`, …) — swap for a DB + OAuth in production.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Extension: `tab not readable` | Reload the vendor tab (extension must predate the page load) |
| Extension: `collected: 0` | Open a real conversation; if it persists, a vendor redesign broke `SELECTORS` in `content.js` — the result box prints per-selector hit counts |
| Extension: `Failed to fetch` | Proxy unreachable from the browser — check `npm run proxy`, then the proxy-host field (see split setup above) |
| Blibs: `Proxy unreachable` pill | Same — `/api/health` is the 5-second test |
| Send stuck on `Sending…` | No open tab for that agent, or tab needs reload — reason shows after the extension's next sweep; hit Retry |
| Your messages on the wrong side | Speaker detection runs on new syncs; clear blibs site data once to re-pull cleanly |

## Limits (honest POC notes)

- Only sees what's rendered in **open, logged-in desktop tabs**. Closed tabs,
  mobile apps, and WhatsApp/Slack DMs are out of reach.
- Sending is best-effort DOM automation (fill composer → click send); vendors
  redesign pages, selectors need maintenance — failures always surface with a reason.
- Personal use on your own accounts; check vendor ToS before productizing.
