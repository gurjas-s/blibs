# Verify conversation search

## Scope

This document covers the `Search all conversations` panel, keyword search,
provider, thread, and date filters, source messages, thread links, index
status, and the experimental local answer path.

It does not cover the current-chat search field. Use
[chat-sending.md](chat-sending.md). It does not cover model quality or a model
download. Read [the search guide](../../../../docs/conversation-search.md) for
storage, migration, and model setup.

## Setup

See [shared setup](README.md#shared-setup).

- Keyword search works without a local model. Do not download a model for this
  document.

## Test steps

1. Start the mock app with the shared command. Complete the first-run card.
   Select `Search all conversations`.
   Expected: the search heading shows. Without a local model, the index state
   shows `Keyword search available` and `Configure a local model to ask`.

2. Import one message:

   ```sh
   curl -s "$BLIBS_BACKEND_URL/api/import" \
     -H 'Content-Type: application/json' \
     -d '{"items":[{"provider":"dots","role":"agent","text":"Atlas uses SQLite for local storage.","ts":1700000000000,"url":"https://chatgpt.com/c/atlas","sourceId":"verify-search-1"}]}'
   ```

   Expected: `{"added":1}`.

3. Search for `SQLite`.
   Expected: one result shows the provider, role, time, thread, and a snippet
   with `SQLite`. The result has `View message` and `Open thread`.

4. Select `View message`.
   Expected: a `Source message` card shows the exact text
   `Atlas uses SQLite for local storage.` Select `Close source`.

5. Set the provider filter to `Dots` and search again. Expected: the result
   stays. Set it to `Grok` and search again. Expected: no result. Set it back to
   `All providers`.

6. Set the `From` and `To` dates to the result date and search again. Expected:
   the result stays. Set `From` to a later date. Expected: no result.

7. Select `Open thread`.
   Expected: the approved vendor host opens in an app window. The panel does
   not navigate to an untrusted address.

8. Read the index state. Without a local embedding model, `Pause indexing` and
   `Rebuild vectors` are disabled. Expected: the state stays `Keyword search
   available`.

9. Manual boundary: `Ask locally` needs a local answer model. The index
   controls need a local embedding model. Do not download a model during a
   review. The desktop test covers the citation flow with a fixed local
   response.

10. Read the outbox: `curl -s "$BLIBS_BACKEND_URL/api/outbox"`.
    Expected: `{"items":[]}`. Search and answers never queue a reply.

## Diagnostics

- A history route returns 403 for the panel origin or 200 for an untrusted
  origin.

Inspect the `/api/search`, `/api/ask`, `/api/index`, and `/api/history/:id` responses.

## Automated coverage

- `tests/history.test.ts` covers migration, source identity, keyword filters,
  paging, chunk bounds, vectors, model fallback, citation validation, source URL
  safety, index resume and cancel, and pause across restarts.
- `tests/proxy.test.ts`, test
  `expanded history APIs reject external browser origins and DNS rebinding hosts`,
  covers the origin and host checks. Run `npm test`.
- `tests/search-desktop.cjs` covers search, filters, paging, a delayed echo,
  exact source citations, and the empty outbox after a search. Run
  `npm run test:desktop`.
