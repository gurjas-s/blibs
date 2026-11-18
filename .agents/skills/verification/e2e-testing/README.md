# End-to-end verification for blibs

This directory has one document for each user-facing feature. Each document
starts from a built app, uses mocked data, and ends with cleanup. An agent can
run one document for one change, or every document for a release.

## Shared setup

Set up and build the checkout with the
[onboarding skill](../../onboarding/SKILL.md). This guide does not repeat those
steps.

Start the mock app from the repository root with this command:

```sh
TMP="$(mktemp -d)"
BLIBS_MOCK_LOGIN=1 \
BLIBS_DATA_DIR="$TMP/history" \
BLIBS_LEGACY_DIR="$TMP" \
BLIBS_NODE_PATH="$(command -v node)" \
BLIBS_UI_PORT=5199 \
PROXY_PORT=8899 \
npm start -- --user-data-dir="$TMP/profile" --remote-debugging-port=9333
```

Non-obvious facts:

- The command uses panel port `5199`, backend port `8899`, and CDP port
  `9333`. Use other values when a port is busy. Then use the same
  `BLIBS_UI_PORT` and `PROXY_PORT` values in every URL.
- The profile is `$TMP/profile`. The history store is `$TMP/history`. Remove
  `$TMP` after the run.
- `BLIBS_MOCK_LOGIN=1` changes only the in-app sign-in steps. The hidden vendor
  views load the public vendor sites and stay signed out.
- Do not use a live vendor login, a real chat, a cookie, or a credential.
  Mark a step that needs a live session as a manual boundary and stop.
- `npm run e2e` and `npm run test:desktop` need a display. On Linux without
  `DISPLAY` or `WAYLAND_DISPLAY`, use `xvfb-run -a npm run e2e`.

## Feature map

| User-facing feature | Document | Main automated check |
| --- | --- | --- |
| Onboarding and first run | [onboarding.md](onboarding.md) | `smoke.spec.ts`: `first run shows the connections matrix and does not reappear` |
| Connections and assistant chat | [connections-chat.md](connections-chat.md) | `smoke.spec.ts`: `panel shows a selected chat and a readable message thread`; `an unconnected assistant shows an inline setup card and a disabled composer`; `connections.test.ts` |
| Vendor login and sessions | [vendor-login.md](vendor-login.md) | `smoke.spec.ts`: `vendor sign-in entry point shows mocked steps and returns home` |
| Chat and sending | [chat-sending.md](chat-sending.md) | `smoke.spec.ts`: `panel shows a selected chat and a readable message thread`; `proxy.test.ts`: outbox; `search-desktop.cjs`: delayed echo |
| Sync and status | [sync-status.md](sync-status.md) | `proxy.test.ts`: legacy imports; `test-harness.ts`: health and sweep |
| Theme and app shell | [theme-app-shell.md](theme-app-shell.md) | `smoke.spec.ts`: theme control and layout |
| Conversation search | [conversation-search.md](conversation-search.md) | `history.test.ts`; `search-desktop.cjs` |
| Icon and branding | [icon-branding.md](icon-branding.md) | `build`; `verify-clean-build`; `smoke.spec.ts`: title |

A feature is part of another document when the feature map does not list it.
For example, local answers are part of conversation search. Do not create a
second document for a sub-feature.

## Choose and run a document

1. Read the feature map. Select the document for the changed feature.
2. Read the shared setup and the document preconditions.
3. Run the automated commands in the document. Stop when a test fails.
4. Start the mock app when the document asks for it.
5. Run the numbered steps in order. Compare each result with the expected
   result.
6. Write the commands and the results in the pull request body or the worker
   report. Do not write a new report file.
7. Do the cleanup at the end of the document.

Run every document when a release changes more than one feature.

## Record the result

- Put the run result in the pull request body or the worker report.
- Attach a screenshot for the pull request body to the PR with
  `gh pr edit <number> --attach <path>`. The repository ignores
  `tests/e2e/artifacts/`.
- Never commit a screenshot, an evidence report, a reproduction note, or a
  verification log.
- Do not commit a screenshot of a logged-in vendor session, a cookie, or a
  credential.

## Add or change a document

Use the [create-test skill](../../create-test/SKILL.md). The example is
[onboarding.md](onboarding.md).
