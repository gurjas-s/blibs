# Topbar search verification

Environment: macOS arm64, Node.js v24.22.3, npm 11.19.1.

All chat data in these checks is mocked. The checks use no vendor account, no
real chat, and no cookie.

## Commands and results

```text
$ npm run build
EXIT:0

$ npm run lint
EXIT:0

$ npm test
22 unit and HTTP tests passed.
ALL DESKTOP HARNESS TESTS PASSED
EXIT:0

$ npm run e2e
5 e2e tests passed.
EXIT:0

$ npm run test:desktop
Desktop search, paging, delayed echo, filters, and citation checks passed.
EXIT:0

$ npm run verify:clean-build
Clean build regenerated the app, preload, backend, panel, and CommonJS markers.
EXIT:0
```

The e2e spec imports two mock Muse messages into a temporary history store. It
then starts the real app with a temporary profile. The app uses the mock chats
from `tests/e2e/harness.ts`.

## Manual checks

1. Open `search-chat-scope.png`. The topbar shows one search input with
   **grocery** and the **This chat** scope. The Muse thread shows only the
   message that contains this text.
2. Type a text with no match. The thread shows **No matches**.
3. Clear the input. The full thread returns.
4. Select **All conversations**. The typed text stays. The main pane shows the
   search filters and no results. The app sends no search request.
5. Press Enter. The main pane shows the retained messages for the query. The
   index state, filters, and paging controls are visible.
6. Open `search-all-scope.png`. The topbar shows the same input with the
   **All conversations** scope and the two retained results.
7. Select a chat in the sidebar. The scope returns to **This chat** and the
   typed text stays.

Result: all steps passed.
