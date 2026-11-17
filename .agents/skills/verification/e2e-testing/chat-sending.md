# Verify chat and sending

## Scope and non-goals

This document covers chat selection in the sidebar, the message thread, role
labels, timestamps, long-text wrapping, the current-chat search field, the
composer, the outbox queue, and the `Sending…`, `Sent`, `Not delivered`, and
`Retry` receipts.

It does not cover conversation search across retained history. Use
[conversation-search.md](conversation-search.md). It does not cover sync
timing. Use [sync-status.md](sync-status.md).

## Preconditions and setup

- Node.js 24 and `npm ci`.
- A successful `npm run build`.
- A display for `npm run e2e` and `npm run test:desktop`.
- A temporary profile and a temporary history directory.
- Mock chats in `blibs-messages-v2`. The e2e harness writes them.

The mock app has no vendor session. A queued send goes to the hidden vendor
view, but that view is signed out. The delivery fails and the receipt shows
`Not delivered`. This is the expected path without a live login.

## Test steps

1. Run `npm run e2e`.
   Expected: exit code 0. The test
   `panel shows a selected chat and a readable message thread` passes. The
   command writes `tests/e2e/artifacts/panel-selected-chat.png`.

2. Run `npm test`.
   Expected: exit code 0. The desktop harness prints
   `ok  - outbox enqueue -> view send -> ack`. This proves the queue, the view
   send, and the acknowledgement with a fake vendor view. It uses no browser
   and no vendor account.

3. Start the mock app with the shared command. Complete the first-run card.
   Expected: the chat shell shows.

4. Open the page console or a CDP client and seed three mock messages:

   ```js
   const now = Date.now();
   localStorage.setItem('blibs-messages-v2', JSON.stringify({ grok: [
     { id: 'verify-1', agentId: 'grok', role: 'agent',
       text: 'The deploy finished at 09:12. Health checks are green.',
       ts: now - 120000, source: 'mock' },
     { id: 'verify-2', agentId: 'grok', role: 'user',
       text: 'Keep the old cluster up until Monday.',
       ts: now - 60000, source: 'mock' },
     { id: 'verify-3', agentId: 'grok', role: 'agent',
       text: 'Scheduled for Monday. Reference: https://example.com/runs/atlas-migration/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa — the runbook has the rollback steps.',
       ts: now, source: 'mock' }
   ] }));
   location.reload();
   ```

   Expected: the sidebar lists `Muse`, `Dots`, and `Grok`. The thread shows the
   three mock messages.

5. Select `Grok` in the sidebar.
   Expected: the thread heading is `Grok`. The thread has
   `aria-label="Messages with Grok"`. The role labels are `Grok`, `You`,
   `Grok`. Each message shows a time.

6. Read the long message.
   Expected: the long URL wraps inside the message bubble. The thread does not
   scroll sideways.

7. Type `deploy` in the `Search current chat` field.
   Expected: only the first mock message shows. Type `zzz`.
   Expected: the empty state says `No matches`. Clear the field.
   Expected: all three messages show.

8. Check the composer with an empty field.
   Expected: `Send` is disabled. Type `verification ping`.
   Expected: `Send` is enabled.

9. Select `Send`.
   Expected: the user message shows at once with `Sending…`. The status line
   shows `Sent to Grok` when the queue call returns. A later pull can replace
   the status line. The message has an outbox id. The receipt stays `Sending…`
   until the main process drains the queue.

10. Wait 30 seconds for the hidden vendor view drain. The drain timer uses a
    30-second interval.
    Expected: the receipt changes to `Not delivered` with a `Retry` button.
    The status line can still show the earlier queue result. This is the
    expected result without a signed-in vendor session.

11. Select `Retry`.
    Expected: the receipt changes to `Sending…` and the status line shows
    `Re-queued`. The item can fail again on the next drain.

12. Type a message and press `Enter`.
    Expected: the app sends the message through the composer, the same as the
    `Send` button.

13. Press `Tab` from the top of the page.
    Expected: the sidebar items, the search field, the theme control, and the
    composer take focus in a logical order. Each control has a visible focus
    state.

14. Manual boundary: a `Sent` receipt needs a signed-in vendor session and a
    vendor page with a composer. Do not use a live account in a review or in
    CI. The headless harness covers the view send and the acknowledgement with
    a fake view.

## Failure signals and artifacts

- The thread shows no messages after the seeded reload.
- A role label is wrong or a timestamp is missing.
- A long URL is clipped or the page scrolls sideways.
- The current-chat search does not filter or does not reset.
- `Send` is enabled with an empty or whitespace-only field.
- The user message disappears when the queue fails.
- The receipt stays on `Sending…` after the view fails.
- `Retry` is missing on a failed message.
- A sent message appears two times after a sync.

Artifacts:

- `tests/e2e/artifacts/panel-selected-chat.png`
- The `npm test` and `npm run e2e` terminal output
- The panel console output
- The temp outbox data under `$TMP/history`

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Keep the screenshot only for the pull request body.

## Automated tests that cover it

- `tests/e2e/smoke.spec.ts`, test
  `panel shows a selected chat and a readable message thread`. It covers the
  selected chat, the thread roles and times, long-text wrapping, the 1024 and
  1440 pixel layouts, and the narrow sidebar toggle. Run `npm run e2e`.
- `tests/proxy.test.ts`, test
  `outbox queues, reports failure, retries, and records delivery`. It covers
  the queue, the failure acknowledgement, retry, and sent status. Run
  `npm test`.
- `src/main/test-harness.ts` covers the outbox loop with a fake vendor view.
  Run `npm test`.
- `tests/search-desktop.cjs` covers a delayed echo and the merge of a sent
  message. Run `npm run test:desktop` on a machine with a display.
- No test sends into a live vendor session. This is intentional.
