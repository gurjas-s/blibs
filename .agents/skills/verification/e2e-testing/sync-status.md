# Verify sync and status

## Scope and non-goals

This document covers the sync pill, the status line, the sidebar sync label,
the auto-sync checkbox and interval, the import pull, import deduplication, the
backend health route, and the outbox status refresh.

It does not cover vendor scraping selectors or a live vendor session. It does
not cover search indexing.

## Preconditions and setup

Shared setup: see [README.md](README.md).

- The shared command starts the backend on `PROXY_PORT` and the panel on
  `BLIBS_UI_PORT`. Use those values in the URLs below.

## Test steps

1. Start the mock app with the shared command. Complete the first-run card.
   Expected: the sync pill changes from `Waiting for sync` to
   `Synced <time>` after the first pull. The status line shows `Up to date`.

2. Import one message:

   ```sh
   curl -s http://127.0.0.1:8899/api/import \
     -H 'Content-Type: application/json' \
     -d '{"items":[{"provider":"dots","role":"agent","text":"synced from the API","ts":2,"sourceId":"verify-sync-1"}]}'
   ```

   Expected: `{"added":1}`. Wait for the 15-second interval. The status line
   shows `1 new message synced`. The `Dots` row changes from `Not synced` to
   `Synced just now`.

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
   `lsof -ti tcp:8899 | xargs kill`.
   Expected: the sync pill shows `Backend unreachable`. The status line shows
   `Backend unreachable — restart the app.`

6. Quit the app and start it again with the same `TMP` value.
   Expected: a new backend starts and the pill returns to a synced state after
   the first pull.

7. Manual boundary: a live vendor sync needs a signed-in vendor session. Do
   not sign in during a review. The automated fake view covers the sweep and
   import path.

## Failure signals and artifacts

- The pill stays on `Waiting for sync`.
- The terminal prints `[blibs] proxy exited` or a backend schema error.
- The same import appears two times after a repeat pull.
- Auto-sync or the interval does not persist after a reload.
- The sidebar label does not change after a new import.

Artifacts: the `/api/health`, `/api/import`, and `/api/imports` responses and
the temp data under `$TMP/history`.

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Stop the backend if it still runs.
3. Remove the temporary directory: `rm -rf "$TMP"`.
4. Do not commit `server/imports.json`, `server/outbox.json`, or a history
   database.

## Automated tests that cover it

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
