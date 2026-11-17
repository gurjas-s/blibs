# End-to-end verification for blibs

This directory has one document for each user-facing feature. Each document
starts from a built app, uses mocked data, and ends with cleanup. An agent can
run one document for one change, or every document for a release.

## Shared preconditions

- Node.js 24. `node -v` must start with `v24.`.
- Dependencies installed with `npm ci`.
- A successful `npm run build`.
- A display for `npm run e2e` and `npm run test:desktop`. On Linux without
  `DISPLAY` or `WAYLAND_DISPLAY`, use `xvfb-run -a npm run e2e`.
- No vendor account. Do not use a live vendor login, a real chat, a cookie, or
  a credential.
- A temporary profile and a temporary history directory.
- Free ports. The examples use panel `5199`, backend `8899`, and CDP `9333`.

The rules in `AGENTS.md` apply. Use mocked data in every test and screenshot.
Do not commit an evidence report.

## Feature map

| User-facing feature | Document | Main automated check |
| --- | --- | --- |
| Onboarding and first run | [onboarding.md](onboarding.md) | `npm run e2e`, `first run shows onboarding steps and does not reappear` |
| Vendor login and sessions | [vendor-login.md](vendor-login.md) | `npm run e2e`, `vendor sign-in entry point shows mocked steps and returns home` |
| Chat and sending | [chat-sending.md](chat-sending.md) | `npm run e2e`, `npm test`, and `npm run test:desktop` |
| Sync and status | [sync-status.md](sync-status.md) | `npm test` and the sync pill check in `npm run e2e` |
| Theme and app shell | [theme-app-shell.md](theme-app-shell.md) | `npm run e2e`, `theme control follows the system preference and persists the choice` |
| Conversation search | [conversation-search.md](conversation-search.md) | `npm test` and `npm run test:desktop` |
| Icon and branding | [icon-branding.md](icon-branding.md) | `npm run build`, `npm run verify:clean-build`, and the title check in `npm run e2e` |

A feature is part of another document when the feature map does not list it.
For example, local answers are part of conversation search. Do not create a
second document for a sub-feature.

## Start a mock app

Use this command to open the real app with fixed sign-in steps and temporary
data. Run it from the repository root.

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

Expected terminal output includes these lines:

```text
blibs proxy on http://127.0.0.1:8899
[blibs] panel on http://127.0.0.1:5199
DevTools listening on ws://127.0.0.1:9333/devtools/browser/...
```

The Electron window opens the panel at `http://127.0.0.1:5199`. Attach a CDP
client to `http://127.0.0.1:9333` when you need to drive the panel from a
script. The hidden vendor views load the public vendor sites and stay signed
out. `BLIBS_MOCK_LOGIN=1` changes only the in-app sign-in steps. It does not
create a vendor session.

Use another port when one is busy. Keep the same `TMP` value for the full run.

## Choose and run a document

1. Read the feature map. Select the document for the changed feature.
2. Read the shared preconditions and the document preconditions.
3. Run `npm run build`.
4. Run the automated commands at the start of the document. Stop when a test
   fails.
5. Start the mock app when the document asks for it.
6. Run the numbered steps in order. Compare each result with the expected
   result.
7. Write the commands and the results in the pull request body or the worker
   report. Do not write a new report file.
8. Do the cleanup at the end of the document.

Run every document when a release changes more than one feature.

## Record the result

- Put the run result in the pull request body or the worker report.
- Put a screenshot for the pull request body in the pull request. The
  repository ignores `tests/e2e/artifacts/`.
- Do not commit a reproduction note, an evidence report, or a verification log.
- Do not commit a screenshot of a logged-in vendor session, a cookie, or a
  credential.

## Add or change a document

Use the [create-test skill](../../create-test/SKILL.md). The example is
[onboarding.md](onboarding.md).
