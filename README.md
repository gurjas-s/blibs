# blibs — personal-agent control panel (POC)

Yes, I understand the idea: **one control panel for personal agents** (the always-on,
action-taking kind — Meta **Muse**, OpenAI **Dots**, xAI **Grok Bot**), not plain chatbots.
This repo is a proof-of-concept: see **all chats in one inbox**, talk to each agent,
or open the vendor's real app embedded next to it.

## API findings (Oct 2026) — why embed + BYOK

| Vendor | Consumer product | Public chat-history API? | What exists for devs |
|---|---|---|---|
| Meta — **Muse** | Muse app, muse.ai web, WhatsApp; runs on secure VM | **No** | Meta Model API (`dev.meta.ai`) with **Muse Spark** models + Muse Code/SDK; Connector Platform |
| OpenAI — **Dots** | Inside ChatGPT/Slack/Teams, GPT-6 Astra, Pro/Business only (launched Sep 29 2026) | **No** standalone Dots API | OpenAI Responses/Chat Completions API, Agents SDK |
| xAI — **Grok Bot** | Named bots on a persistent cloud computer (beta, via Cursor/SuperGrok) | **No** bot-session history API | xAI API at `api.x.ai/v1` (OpenAI-compatible), models `grok-4.7`, `grok-4.20-multi-agent` |

So the POC uses the **adapter pattern**:
- **Unified chat here** — talks live through your own keys (BYOK) via `server/proxy.mjs`,
  otherwise a clearly-labeled **mock** so the UX is demoable with zero keys.
- **Embedded app tab** — iframes `muse.meta.ai` / `chatgpt.com` / `grok.com`
  (vendors often send `X-Frame-Options: DENY`, so a fallback "open in new tab" link is included).
- When vendors ship history APIs, swap the mock/iframe for a real sync — the `ProviderMeta`
  table in `src/providers.ts` is the seam.

## Run it

```bash
npm install
npm run dev      # frontend on :5173
npm run proxy    # optional: :8787, keeps keys server-side; vite forwards /api
```

Paste keys in the **API keys** bar (stored in `localStorage` only):
`META_API_KEY` · `OPENAI_API_KEY` · `XAI_API_KEY`.

## Layout

- **Left**: agent roster (Muse, Dots, Grok Bot + add your own).
- **Center**: per-agent view with 3 tabs — `Unified chat` / `Embedded app` / `API / adapter`.
- **Right**: unified inbox — search across *all* agents' chats.
- Persistence is `localStorage` (`blibs-messages-v1`, `blibs-keys-v1`, `blibs-agents-v1`).
  Swap for a DB + OAuth in production.

## Companion extension (POC — the live sync path)

Iframes are blocked by all three vendors (verified headers: `SAMEORIGIN` /
`DENY`), so the site can't embed them. Instead `extension/` is a Manifest V3
companion: with your permission it reads **your own logged-in tabs** on
`muse.ai`, `chatgpt.com`, `grok.com` and POSTs chats to the local proxy
(`POST /api/import`, persisted in `server/imports.json`). The inbox has a
**Pull from extension** button (`GET /api/imports`) that merges them as
`source: 'extension'` messages. Full install/sync instructions in
`extension/README.md`. Yes — vendor tabs must be open + logged in; that is the
documented trade-off until vendors ship history APIs.

## Files

- `src/App.tsx` — whole panel (incl. Pull-from-extension merge)
- `src/providers.ts` — vendor metadata, embed URLs, mock replies
- `src/types.ts` — Agent / ChatMessage / ProviderMeta
- `server/proxy.mjs` — zero-dependency fan-out to Meta/OpenAI/xAI + `/api/import(s)`
- `extension/` — MV3 companion (manifest, content, background, popup)
- `.env.example` — keys + optional custom endpoint
