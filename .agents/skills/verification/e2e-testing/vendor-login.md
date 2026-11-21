# Verify vendor login and sessions

## Scope and non-goals

This document covers the agents screen, the in-app sign-in entry point, the
inline sign-in steps, `Check again`, `Open website`, `Cancel`, `Back to chats`,
Escape, and the persistent vendor partition.

It does not cover a real vendor account, a verification code, or a CAPTCHA. It
does not cover chat sync or message sending.

## Preconditions and setup

Shared setup: see [README.md](README.md).

- `BLIBS_MOCK_LOGIN=1`. The shared command sets it. The mock reports a verification step and a signed-in step.

## Test steps

1. Start the mock app with the shared command. Complete the first-run card.
   Expected: the chat shell shows.

2. Select `Agents`.
   Expected: the heading is `Agents`. The cards are `Muse`, `Dots`, and `Grok`.
   Each card shows `Not signed in. Select Sign in to open the provider website in blibs.`
   The `Back to chats` button is visible.

3. Select `Sign in` on the Muse card.
   Wait for the verification step.
   Expected: the status is
   `Enter the mobile verification code in the Muse website, then select Check again.`
   The card shows `Check again`, `Open website`, and `Cancel`.

4. Select `Check again`.
   Expected: the status is
   `Signed in to Muse. The session stays on this device.` The primary button is
   `Sign in again`.

5. Select `Sign in again`, wait for the verification step, then select
   `Cancel`.
   Expected: the status is `Sign-in cancelled for Muse. You can try again.`

6. Press `Escape`. Open the agents screen again, then select `Back to chats`.
   Expected: the chat shell returns both times.

7. Select `Open website` in the connected Muse chat. Type `Text to copy` in
   the mock website's `Message` field. Select all, copy, clear the field, and
   paste with the system shortcuts. Press Escape while the field has focus.
   Expected results include the pasted text and a return to the local chat.

8. Quit the app and start it again with the same `TMP` value. Open the agents
   screen.
   Expected: each card shows the default `Not signed in` message because the
   login status is held in memory. A real session cookie stays in the
   persistent vendor partition across the restart.

9. Manual boundary: a real vendor sign-in needs an account, possibly a mobile
   code or a CAPTCHA, and a vendor page. Do not do this in a review or in CI.
   Stop and ask the user. Do not read, copy, or commit a cookie.

## Failure signals and artifacts

- The panel shows `Vendor sign-in needs the blibs desktop app.`
- A card stays on `Opening…` or `Loading…` and never reports the next step.
- `Cancel`, `Check again`, or `Open website` is missing when it is needed.
- Escape or `Back to chats` does not return to the chat shell.
- The status shows a vendor error or an IPC error.
- The mock sign-in asks for a real account or a real code.

Artifacts: `tests/e2e/artifacts/login-dark.png`, `login-light.png`,
`home-after-login-dark.png`, `home-after-login-light.png`, and
`provider-controls.png`.

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Do not commit a screenshot of a signed-in vendor session.

## Automated tests that cover it

`tests/e2e/smoke.spec.ts`, test
`vendor sign-in entry point shows mocked steps and returns home`, covers the
agents screen, three vendor cards, the mocked verification step, `Check again`,
`Cancel`, a completed sign-in, the mock website, clipboard shortcuts, Escape, and
`Back to chats`. The mock uses a local HTML page. No unit test covers the login
controller.

Run the check with:

```sh
npm run e2e
```
