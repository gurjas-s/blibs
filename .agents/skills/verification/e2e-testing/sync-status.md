# Verify sync and status

## Scope

This document covers the sync pill, the status announcement, the sidebar sync
label, the auto-sync checkbox and interval, the import pull, import
deduplication, the backend health route, and the outbox status refresh.

The authenticated check covers the real vendor collection path. Search
indexing has its own guide.

## Setup

See [shared setup](README.md#shared-setup).

## Test steps

1. Start the mock app with the shared command. Complete the first-run card.
   Expected: the sync pill changes from `Waiting for sync` to
   `Synced <time>` after the first pull. The status announcement reads
   `Up to date`.

2. Import one message:

   ```sh
   curl -s "$BLIBS_BACKEND_URL/api/import" \
     -H 'Content-Type: application/json' \
     -d '{"items":[{"provider":"dots","role":"agent","text":"synced from the API","ts":2,"sourceId":"verify-sync-1"}]}'
   ```

   Expected: `{"added":1}`. Wait for the 15-second interval. The status
   announcement reads `1 new message synced`. The `Dots` row changes from
   `Not synced` to `Synced just now`.

3. Run the same command again.
   Expected: `{"added":0}`. The message does not appear twice.

4. Open Settings and uncheck `Auto-sync` in the `Sync` section.
   Expected: `localStorage.getItem('blibs-autopull-v1')` is `false`. Select
   `30s` in `Auto-sync interval`. Expected:
   `localStorage.getItem('blibs-pullsecs-v1')` is `30`. Reload the panel.
   Expected: both values persist, and one pull still runs on load. Check
   `Auto-sync` and select `15s`. Expected: the sidebar footer shows only the
   `Agents` entry and no sync controls.

5. Stop the backend process, then wait for the next pull:
   Use the backend port printed for this mock session. On macOS, find the
   listener with `lsof -nP -iTCP:<backend-port> -sTCP:LISTEN`, then stop that
   backend with `kill <pid>`.
   Expected: the sync pill shows `Backend unreachable`. The status
   announcement reads `Backend unreachable — restart the app.`

6. Quit the app and start a new mock session. Complete the first-run card.
   Expected: a new backend starts and the pill returns to a synced state after
   the first pull.

7. For vendor sync changes, use the
   [authenticated profile](../SKILL.md#authenticated-provider-checks).
   Open the current conversation in the provider and check that its
   messages appear once in the matching blibs thread after sync.

## Diagnostics

- The terminal prints `[blibs] proxy exited` or a backend schema error.

Artifacts: the `/api/health`, `/api/import`, and `/api/imports` responses.

## Automated coverage

- `tests/proxy.test.ts`, test
  `legacy imports deduplicate exact provider/thread/role/timestamp/text observations and survive restart`,
  covers the import route, deduplication, and restart. `src/main/test-harness.ts`
  covers the health route, the panel API fan-out, the outbox loop, and the
  sweep into the import store. Run `npm test`.
- `tests/e2e/smoke.spec.ts`, test
  `panel shows a selected chat and a readable message thread`, waits for the
  `Synced` pill and checks `/api/health` through the panel and directly. Test
  `sync controls live in Settings and apply to the running timer` checks the
  Settings controls, both storage keys, and the removed sidebar controls. Run
  `npm run e2e`.
- `src/main/index.ts` owns the 60-second sweep and the 30-second outbox drain.
  No unit test covers the timer values.
