# Verify chat and sending

## Scope and non-goals

This document covers chat selection in the sidebar, the message thread, role
labels, timestamps, long-text wrapping, the current-chat search field, the
composer, the outbox queue, and the `Sending…`, `Sent`, `Not delivered`, and
`Retry` receipts.

It does not cover conversation search across retained history. Use
[conversation-search.md](conversation-search.md). It does not cover sync timing.
Use [sync-status.md](sync-status.md).

## Preconditions and setup

Shared setup: see [README.md](README.md).

- The mock chat fixture in step 2.
- No vendor session. A queued send reaches the hidden signed-out view, fails,
  and shows `Not delivered`. This is the expected path without a live login.

## Test steps

1. Start the mock app with the shared command. Complete the first-run card.
   Expected: the chat shell shows.

2. Seed three mock messages in the page console or a CDP client:

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
       text: 'Scheduled for Monday. Reference: https://example.com/runs/atlas-migration/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa — the runbook has the rollback steps.',
       ts: now, source: 'mock' }
   ] }));
   location.reload();
   ```

   Expected: the sidebar lists `Muse`, `Dots`, and `Grok`. The thread shows the
   three messages.

3. Select `Grok`.
   Expected: the thread heading is `Grok`, the thread has
   `aria-label="Messages with Grok"`, and the role labels are `Grok`, `You`,
   `Grok`. Each message shows a time.

4. Read the long message.
   Expected: the URL wraps inside the bubble. The thread does not scroll
   sideways.

5. Type `deploy` in `Search current chat`. Expected: one message shows. Type
   `zzz`. Expected: `No matches`. Clear the field. Expected: three messages
   show.

6. With an empty composer, `Send` is disabled. Type `verification ping`.
   Expected: `Send` is enabled. Select `Send`.
   Expected: the message shows at once with `Sending…`. The status line shows
   `Sent to Grok` when the queue call returns. A later pull can replace it.

7. Wait 30 seconds for the hidden view drain.
   Expected: the receipt changes to `Not delivered` with `Retry`.

8. Select `Retry`.
   Expected: the receipt changes to `Sending…` and the status line shows
   `Re-queued`.

9. Type a message and press `Enter`.
   Expected: the composer sends it. Press `Tab` through the page.
   Expected: each control has a visible focus state.

10. Manual boundary: a `Sent` receipt needs a signed-in vendor session and a
    vendor page with a composer. Do not use a live account in a review or in
    CI. The headless harness covers the view send and the acknowledgement with
    a fake view.

## Failure signals and artifacts

- The thread shows no messages after the seeded reload.
- A role label is wrong, a timestamp is missing, or a long URL clips.
- The current-chat search does not filter or does not reset.
- `Send` is enabled with an empty or whitespace-only field.
- The user message disappears when the queue fails.
- The receipt stays on `Sending…` after the view fails, or `Retry` is missing.
- A sent message appears two times after a sync.

Artifacts: `tests/e2e/artifacts/panel-selected-chat.png` and the temp outbox
data under `$TMP/history`.

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Keep the screenshot only for the pull request body.

## Automated tests that cover it

- `tests/e2e/smoke.spec.ts`, test
  `panel shows a selected chat and a readable message thread`, covers the
  selected chat, roles, times, long-text wrapping, both desktop widths, and the
  narrow sidebar toggle. Run `npm run e2e`.
- `tests/proxy.test.ts`, test
  `outbox queues, reports failure, retries, and records delivery`, and
  `src/main/test-harness.ts` cover the queue, failure, retry, sent status, and
  the view send with a fake view. Run `npm test`.
- `tests/search-desktop.cjs` covers a delayed echo and the merge of a sent
  message. Run `npm run test:desktop`.
- No test sends into a live vendor session. This is intentional.
