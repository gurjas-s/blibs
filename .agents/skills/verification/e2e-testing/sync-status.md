# Verify sync and status

## Scope and non-goals

This document covers the sync pill, the status line, the sidebar sync label,
the auto-sync checkbox and interval, the import pull, import deduplication, the
backend health route, and the outbox status refresh.

It does not cover vendor scraping selectors or a live vendor session. It does
not cover search indexing.

## Preconditions and setup

- Node.js 24 and `npm ci`.
- A successful `npm run build`.
- A temporary history directory.
- Free backend and panel ports. The examples use `8899` and `5199`.
- No vendor account.

The mock app starts the real backend and the real panel. The hidden vendor
views stay signed out, so no real chat is imported. Use the API and a temporary
store to test the sync path.

## Test steps

1. Run `npm test`.
   Expected: exit code 0. The desktop harness prints these lines:
   `ok  - backend boots + health`, `ok  - static panel + /api fan-out`,
   `ok  - outbox enqueue -> view send -> ack`, and
   `ok  - sweep collect -> import store`. It ends with
   `ALL DESKTOP HARNESS TESTS PASSED`.

2. Start the backend alone with a temporary store:

   ```sh
   TMP="$(mktemp -d)"
   BLIBS_DATA_DIR="$TMP/history" PROXY_PORT=8899 node build/server/proxy.js
   ```

   Expected: the terminal prints `blibs proxy on http://127.0.0.1:8899`.
   The process stays in the foreground.

3. In a second terminal, check the health route:
   `curl -s http://127.0.0.1:8899/api/health`.
   Expected: `{"ok":true}`.

4. Import one item:

   ```sh
   curl -s http://127.0.0.1:8899/api/import \
     -H 'Content-Type: application/json' \
     -d '{"items":[{"provider":"dots","role":"agent","text":"sync check","ts":1,"sourceId":"verify-sync-1"}]}'
   ```

   Expected: `{"added":1}`. Run the same command again.
   Expected: `{"added":0}`. The store deduplicates the item.

5. Read the imports: `curl -s http://127.0.0.1:8899/api/imports`.
   Expected: the response has one item with text `sync check`.

6. Stop the backend with `Ctrl+C`. Start the mock app with the shared command.
   Complete the first-run card.
   Expected: the panel loads. The sync pill changes from `Waiting for sync` to
   `Synced <time>` after the first pull. The status line shows `Up to date` or
   `<n> new messages synced`.

7. Post an import to the running app backend:

   ```sh
   curl -s http://127.0.0.1:8899/api/import \
     -H 'Content-Type: application/json' \
     -d '{"items":[{"provider":"dots","role":"agent","text":"synced from the API","ts":2,"sourceId":"verify-sync-2"}]}'
   ```

   Expected: `{"added":1}`. Wait for the auto-sync interval (15 seconds by
   default). The status line shows `1 new message synced`. The pill time
   updates. The `Dots` sidebar row changes from `Not synced` to
   `Synced just now`.

8. Uncheck `Auto-sync`.
   Expected: the timer stops. Read
   `localStorage.getItem('blibs-autopull-v1')` in the page console.
   Expected: `false`.

9. Select `30s` in the `Auto-sync interval` control.
   Expected: `localStorage.getItem('blibs-pullsecs-v1')` is `30`.

10. Reload the panel.
    Expected: `Auto-sync` stays unchecked and the interval stays `30s`. The
    panel still runs one pull on load. The pill shows a sync time.

11. Check `Auto-sync` and select `15s`. Expected: the timer runs again.

12. Stop the backend process while the app runs:
    `lsof -ti tcp:8899 | xargs kill`.
    Expected: the next pull fails. The sync pill shows `Backend unreachable`.
    The status line shows `Backend unreachable — restart the app.`

13. Quit the app. Start it again with the same `TMP` value.
    Expected: the app starts a new backend and the pill returns to a synced
    state after the first pull.

14. Manual boundary: a live vendor sync needs a signed-in vendor session. Do
    not sign in during a review. Use the fake view in `npm test` for the sweep
    and import path.

## Failure signals and artifacts

- The pill stays on `Waiting for sync`.
- The panel proxy returns 502 for `/api/health`.
- The terminal prints `[blibs] proxy exited` or a backend schema error.
- The same import appears two times after a repeat pull.
- The status line stays stale after a pull.
- Auto-sync or the interval does not persist after a reload.
- The sidebar label does not change after a new import.

Artifacts:

- The `npm test` terminal output
- The `/api/health`, `/api/import`, and `/api/imports` responses
- The app terminal output
- The temp data under `$TMP/history`

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Stop the standalone backend if it still runs.
3. Remove the temporary directory: `rm -rf "$TMP"`.
4. Do not commit `server/imports.json`, `server/outbox.json`, or a history
   database.

## Automated tests that cover it

- `tests/proxy.test.ts`, test
  `legacy imports deduplicate exact provider/thread/role/timestamp/text observations and survive restart`.
  It covers the import route, the deduplication, and the restart path. Run
  `npm test`.
- `src/main/test-harness.ts` covers the backend health route, the panel API
  fan-out, the outbox loop, and the sweep into the import store. Run
  `npm test`.
- `tests/e2e/smoke.spec.ts`, test
  `panel shows a selected chat and a readable message thread`, waits for the
  `Synced` pill and checks `/api/health` through the panel and directly. Run
  `npm run e2e`.
- `src/main/index.ts` owns the 60-second sweep and the 30-second outbox drain.
  No unit test covers the timer values.
