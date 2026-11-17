# Verify conversation search

## Scope and non-goals

This document covers the `Search all conversations` panel, keyword search,
provider, thread, and date filters, result paging, source messages, thread
links, index status, pause and resume, rebuild, and the experimental local
answer path.

It does not cover the current-chat search field. Use
[chat-sending.md](chat-sending.md). It does not cover model quality or a model
download. Read [the search guide](../../../../docs/conversation-search.md) for
storage, migration, and model setup.

## Preconditions and setup

- Node.js 24. The backend uses SQLite from `node:sqlite`.
- `npm ci` and a successful `npm run build`.
- A display for `npm run test:desktop`.
- A temporary history directory.
- No vendor account. No model download.

Keyword search works without a local model. This document uses keyword search
and a fixed local answer server in the desktop test. It does not test answer
quality.

## Test steps

1. Run `npm test`.
   Expected: exit code 0. The history and route tests pass. The relevant files
   are `tests/history.test.ts` and `tests/proxy.test.ts`.

2. Run `npm run test:desktop`.
   Expected: exit code 0. The check prints
   `Desktop search, paging, delayed echo, filters, and citation checks passed.`
   It uses a temporary history store, a separate profile, and a fixed local
   model response. It downloads no model.

3. Start the mock app with the shared command. Complete the first-run card.
   Expected: the chat shell shows.

4. Select `Search all conversations` in the sidebar.
   Expected: the heading is `Search conversations`. The `Search or ask` field,
   the filters, the `Search` button, and the index state show. Without a local
   model, the index state shows `Keyword search available` and
   `Configure a local model to ask`.

5. Import one deterministic message:

   ```sh
   curl -s http://127.0.0.1:8899/api/import \
     -H 'Content-Type: application/json' \
     -d '{"items":[{"provider":"dots","role":"agent","text":"Atlas uses SQLite for local storage.","ts":1700000000000,"url":"https://chatgpt.com/c/atlas","sourceId":"verify-search-1"}]}'
   ```

   Expected: `{"added":1}`.

6. Type `SQLite` in `Search or ask` and select `Search`.
   Expected: one result shows. The result shows `dots`, `agent`, a time, the
   thread `atlas` or its URL, and a snippet with `SQLite`. It has `View
   message` and `Open thread` actions.

7. Select `View message`.
   Expected: a `Source message` card shows. Its blockquote is exactly
   `Atlas uses SQLite for local storage.` Select `Close source`.
   Expected: the source card closes.

8. Set `Provider` to `Dots` and select `Search`.
   Expected: the result stays. Set `Provider` to `Grok` and select `Search`.
   Expected: the panel shows `No matching retained messages. Try another query
   or provider.` Set `Provider` back to `All providers`.

9. Select the result date as the `From` and `To` date, then select `Search`.
   Expected: the result stays. Set `From` to a later date and select `Search`.
   Expected: the result list is empty.

10. Import 12 messages for paging:

    ```sh
    node --input-type=module -e "const items=Array.from({length:12},(_,n)=>({provider:'dots',role:'agent',text:'Atlas paging record '+n,ts:1700000000000+n,sourceId:'page-'+n,url:'https://chatgpt.com/c/paging'})); console.log(JSON.stringify({items}))" | curl -s http://127.0.0.1:8899/api/import -H 'Content-Type: application/json' --data-binary @-
    ```

    Expected: `{"added":12}`.

11. Type `Atlas paging` and select `Search`.
    Expected: 10 results show. The `Next` button is enabled. Select `Next`.
    Expected: 2 results show. Select `Previous`.
    Expected: 10 results show.

12. Change the query to `Atlas paging record 1`.
    Expected: the old results and the paging controls are removed before the
    new search. Select `Search`.
    Expected: three results show: records `1`, `10`, and `11`.

13. Select `Open thread` on a result.
    Expected: the approved vendor host opens in an app window. It does not
    navigate the panel to an untrusted address.

14. Read the index state. Without a local embedding model, `Pause indexing`
    and `Rebuild vectors` are disabled.
    Expected: the state stays `Keyword search available`.

15. Manual boundary: `Ask locally` needs a local answer model. The index
    controls need a local embedding model. Do not download a model during a
    review. Follow
    [the search guide](../../../../docs/conversation-search.md) when the user
    asks for the model path. The desktop test covers the citation flow with a
    fixed local response.

16. After the search and the answer checks, read the outbox:
    `curl -s http://127.0.0.1:8899/api/outbox`.
    Expected: `{"items":[]}`. Search and answers never queue a reply.

## Failure signals and artifacts

- A history route returns 403 for the panel origin or 200 for an untrusted
  origin.
- A keyword search returns no result for an imported message.
- A filter does not change the result set.
- A changed input leaves old results or old paging controls.
- `Next` returns fewer than the expected page or repeats a result.
- `View message` shows a different text than the citation.
- An answer cites an unknown source or an invented quote.
- The outbox has an item after a search.
- The index count does not change, or the pause state does not persist.

Artifacts:

- The `npm test` and `npm run test:desktop` terminal output
- The `/api/search`, `/api/ask`, `/api/index`, and `/api/history/:id` responses
- The temp history directory under `$TMP/history`
- No screenshot is written by the desktop search check

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Do not commit a history database or an answer log.

## Automated tests that cover it

- `tests/history.test.ts` covers migration, source identity, keyword filters,
  paging, chunk bounds, vectors, model fallback, citation validation, source
  URL safety, index resume and cancel, and pause across restarts. Run
  `npm test`.
- `tests/proxy.test.ts`, test
  `expanded history APIs reject external browser origins and DNS rebinding hosts`,
  covers the origin and host checks for the history routes. Run `npm test`.
- `tests/search-desktop.cjs` covers search, filters, paging, a delayed echo,
  exact source citations, and the empty outbox after a search. Run
  `npm run test:desktop` on a machine with a display.
- `docs/conversation-search.md` describes the storage, migration, and model
  setup.
