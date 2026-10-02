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
5. Click the icon → **Sync open vendor tabs now**.
6. Open blibs (`npm run dev`) → inbox shows a new **“via extension”** section.
   Hit **Pull from extension** to merge.

## How it works

- `content.js` runs in each vendor page, finds message nodes
  (`[data-message-author-role]` first, generic fallbacks after), and sends
  `{ provider, role, text, ts, url }` to `background.js`.
- `background.js` POSTs batches to `/api/import` (dedupe by
  `provider|role|text`), plus a 10-min alarm nudge for open tabs.
- `server/proxy.mjs` persists to `server/imports.json` (cap 2000, serves last 500).
- `src/App.tsx` pulls `/api/imports` on demand and merges into the thread +
  unified inbox with `source: 'extension'`.

## Limits (honest POC notes)

- Only sees conversations **rendered in open, logged-in tabs**. Closed tabs,
  mobile apps, WhatsApp/Slack DMs are out of reach.
- Vendor DOM redesigns break selectors — update `SELECTORS` in `content.js`.
- Personal use on your own account; check vendor ToS before productizing.
