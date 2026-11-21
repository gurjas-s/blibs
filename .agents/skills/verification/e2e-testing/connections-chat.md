# Verify connections and the assistant chat

## Scope and non-goals

This document covers the connected assistant chat, the context column, the
harness switches, the recent activity list, the inline setup card for an
unconnected assistant, the disabled composer, and the narrow-width layout.

It does not cover the first-run connections screen. Use
[onboarding.md](onboarding.md) for that screen. It does not cover a real vendor
sign-in. Use [vendor-login.md](vendor-login.md) for the mock sign-in steps. It
does not cover sending a message that reaches a vendor.

## Preconditions and setup

Shared setup: see [README.md](README.md).

- A completed first run: `blibs-onboarding-v1` is `done`.
- No action card is required. The action card is part of the message data. The
  automated test in `smoke.spec.ts` covers it.

Seed mock connection state in the panel. Run this command in the DevTools
console, then reload:

```js
localStorage.setItem('blibs-connections-v1', JSON.stringify({
  folder: '~/Projects',
  assistants: {
    muse: { setup: 'connected', harnesses: { 'claude-code': true, codex: false, opencode: true } },
    dots: { setup: 'connected', harnesses: { 'claude-code': false, codex: true, opencode: true } },
    grok: { setup: 'setup', harnesses: { 'claude-code': true, codex: true, opencode: false } },
  },
  activity: [{
    id: 'check-1',
    assistantId: 'muse',
    harness: 'claude-code',
    title: 'Fixed login button',
    detail: 'Updated the login handler and ran 12 tests in ~/Projects/blibs.',
    status: 'completed',
    at: Date.now() - 600000,
  }],
}));
location.reload();
```

The state is local mock data. Do not use a real chat, a cookie, or a credential.

## Test steps

1. Read the assistant list.
   Expected: `Muse` and `Dots` show `Connected`. `Grok` shows `Setup` and `Not
   connected yet`. `Muse` shows `Fixed login button` as the detail line.

2. Select `Muse`.
   Expected: the chat header shows `Muse` and the `Connected` pill. The composer
   is enabled. The context column shows at a wide window.

3. Read the context column.
   Expected result. Recent activity lists `Fixed login button`. The folder in
   the preview matches the relay's projects folder. Muse has one switch for
   OpenCode. Claude Code and Codex show `Unsupported`.

4. Turn OpenCode off in the context column. Open Connections.
   Expected result. The OpenCode switch for Muse is off. Turn it on again.

5. Set the window to 1024 pixels wide.
   Expected: the context column is not visible. The `Context` button is visible.
   The layout does not scroll sideways.

6. Select `Context`.
   Expected: the context column shows as an overlay. Its switch names still
   work. Select `Close context`. The overlay closes.

7. Set the window to 800 pixels wide.
   Expected: the sidebar is hidden. The `Chats` toggle shows the sidebar.

8. Select `Grok`.
   Expected: the header shows the `Setup` pill. The setup card shows the heading
   `Connect Grok to blibs` and three numbered steps. The link is
   `https://blibs.app/c/grok`. The card has `Copy`, `Check connection`, and
   `Open Grok`. The composer is disabled and shows the reason
   `Connect Grok above before you send a message.`.

9. Select `Check connection`.
   Expected: the button shows `Checking…` and then returns to `Check
   connection`. If the mock sign-in is not active, the state stays `Setup`.

10. Select `Edit tools`.
    Expected: the connections screen shows. Select `Back to chats`. The chat
    returns.

11. Run the scripted Muse request check.

    ```sh
    npm run build
    node --import tsx --test --test-name-pattern='Connections applies the saved folder' tests/e2e/smoke.spec.ts
    ```

    Expected result. The test saves a new projects folder in Connections. It
    sends a request from the Muse composer and imports scripted Muse turns.
    Disabled OpenCode and unsupported combinations start no work. Enabled
    OpenCode creates `alpha/hello.txt` with the exact text `Hello from blibs.`
    in the new folder. The old folder stays unchanged.

## Failure signals and artifacts

- The assistant list shows `Connected` for an assistant with `setup: 'setup'`
  and no signed-in session, or the opposite.
- The context column does not show at a wide window, or it covers the chat at a
  wide window.
- The harness switch does not change the saved state.
- The composer is enabled for an unconnected assistant.
- A control is unreachable at 800 or 1024 pixels.
- The console shows a React or storage error.
- A screenshot is missing from `tests/e2e/artifacts/`.

Artifacts: `tests/e2e/artifacts/chat-connected-dark.png` and
`chat-setup-light.png`.

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Keep screenshots only for the pull request body.

## Automated tests that cover it

`tests/e2e/smoke.spec.ts`, test
`panel shows a selected chat and a readable message thread`, covers the action
card, the context column at 1440 pixels, the overlay at 1024 and 800 pixels, the
sidebar toggle, and both chat screenshots. Test
`an unconnected assistant shows an inline setup card and a disabled composer`
covers the `Setup` pill, the three steps, the connect link, the card controls,
and the disabled composer. Test
`Connections applies the saved folder and harness setting to Muse requests`
covers the scripted request and folder save. `tests/connections.test.ts` covers the state module
and the setup derivation.

Run the check with:

```sh
npm run e2e
```
