# blibs companion extension (POC)

Reads **your own logged-in chats** on `muse.ai`, `chatgpt.com`, `grok.com` and
POSTs them to your local blibs proxy (`http://127.0.0.1:8787/api/import`).
Nothing leaves your machine.

## Install (Chrome / Edge / Brave — 1 min)

1. Run the blibs backend once: `npm run proxy` (keeps `:8787` listening).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select this `extension/` folder.
4. Pin the ◍ blibs icon. Open + log in to `muse.ai`, `chatgpt.com`, `grok.com`
   (pinned tabs work best — the extension can only read tabs you have open).
5. That's it — syncing is automatic from here (real-time pushes on chat
   changes + sweep every few minutes). The popup's Sync buttons are manual
   overrides with diagnosis output.
6. Open blibs (`npm run dev`) → the inbox **auto-pulls** every 15s by default
   (toggle + interval above the inbox, "Pull now" for manual). Merged chats
   carry `extension` badges.

## How it works (now fully automatic)

- `content.js` runs in each vendor page, finds message nodes, and pushes on
  page load **plus automatically**: a debounced `MutationObserver` pushes
  ~8s after chat content changes, with a 60s heartbeat backup.
- `background.js` POSTs batches to `/api/import` (dedupe by
  `provider|role|text`), plus a configurable backup sweep (popup → auto-sync
   every N min, default 1, `0` = off; real-time pushes stay on regardless).
- Popup shows per-tab Sync (manual override), last attempt diagnosis, last
  auto-sweep, and the proxy-host override for VM setups.
- `server/proxy.mjs` persists pushes to `server/imports.json` (cap 2000,
  serves last 500).

## Limits (honest POC notes)

- Only sees conversations **rendered in open, logged-in tabs**. Closed tabs,
  mobile apps, WhatsApp/Slack DMs are out of reach.
- Vendor DOM redesigns break selectors — update `SELECTORS` in `content.js`.
- Personal use on your own account; check vendor ToS before productizing.
