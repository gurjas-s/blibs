# Verify vendor login and sessions

## Scope and non-goals

This document covers the agents screen, the in-app sign-in entry point, the
inline sign-in steps, `Check again`, `Open window`, `Cancel`, `Back to chats`,
Escape, and the persistent vendor partition.

It does not cover a real vendor account, a real verification code, or a
CAPTCHA. It does not cover chat sync or message sending.

## Preconditions and setup

- Node.js 24 and `npm ci`.
- A successful `npm run build`.
- A display for `npm run e2e`.
- No vendor account.
- A temporary profile with `BLIBS_MOCK_LOGIN=1`.

`BLIBS_MOCK_LOGIN=1` makes the sign-in steps deterministic. The mock reports an
opening step, a loading step, a mobile verification step, and a signed-in step.
It uses no vendor page and no account.

## Test steps

1. Run `npm run e2e`.
   Expected: exit code 0. The test
   `vendor sign-in entry point shows mocked steps and returns home` passes. The
   command writes `login-dark.png`, `login-light.png`,
   `home-after-login-dark.png`, and `home-after-login-light.png` in
   `tests/e2e/artifacts/`.

2. Start the mock app with the shared command. Complete the first-run card.
   Expected: the chat shell shows.

3. Select `Agents and sign-in` in the sidebar.
   Expected: the heading is `Agents`. The screen lists three vendor cards:
   `Muse`, `Dots`, and `Grok`. The `Back to chats` button is visible.

4. Read one vendor card.
   Expected: it shows the product name, the vendor and the blurb, a status
   message `Not signed in. Select Sign in to open the vendor window.`, and a
   `Sign in` button.

5. Select `Sign in` on the Muse card.
   Expected: the status changes to `Opening the Muse sign-in window…`, then
   `Loading the Muse sign-in page…`. The card shows a `Cancel` button while the
   step is in progress.

6. Wait for the mock verification step.
   Expected: the status is
   `Enter the mobile verification code in the Muse window, then select Check again.`
   The card shows `Check again`, `Open window`, and `Cancel`.

7. Select `Check again`.
   Expected: the status is
   `Signed in to Muse. The session stays on this device.` The primary button is
   `Sign in again`. `Check again` is not shown.

8. Select `Sign in again`, wait for the verification step, then select
   `Cancel`.
   Expected: the status is `Sign-in cancelled for Muse. You can try again.`
   The card shows `Sign in`.

9. Press `Escape`.
   Expected: the agents screen closes and the chat shell shows.

10. Select `Agents and sign-in` again. Select `Back to chats`.
    Expected: the agents screen closes and the chat shell shows.

11. Quit the mock app. Start it again with the same `TMP` value. Open the
    agents screen.
    Expected: each vendor card shows the default `Not signed in` message. The
    login status is held in memory and does not persist across a restart. The
    persistent vendor partition keeps a real session cookie across a restart.
    This is the session boundary for the mock path.

12. Manual boundary: a real vendor sign-in needs an account, possibly a mobile
    code or a CAPTCHA, and a vendor page. Do not do this in a review or in CI.
    Stop and ask the user. Do not read, copy, or commit a cookie.

## Failure signals and artifacts

- The panel shows `Vendor sign-in needs the blibs desktop app.` inside the
  Electron app.
- A card stays on `Opening…` or `Loading…` and never reports the next step.
- `Cancel` is missing while a step is in progress.
- `Check again` or `Open window` is missing on the verification step.
- Escape or `Back to chats` does not return to the chat shell.
- The status shows a vendor error or an IPC error.
- The mock sign-in asks for a real account or a real code.

Artifacts:

- `tests/e2e/artifacts/login-dark.png`
- `tests/e2e/artifacts/login-light.png`
- `tests/e2e/artifacts/home-after-login-dark.png`
- `tests/e2e/artifacts/home-after-login-light.png`
- The `npm run e2e` terminal output

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Do not commit a screenshot of a signed-in vendor session.
4. Keep the mock screenshots only for the pull request body.

## Automated tests that cover it

- `tests/e2e/smoke.spec.ts`, test
  `vendor sign-in entry point shows mocked steps and returns home`. It covers
  the agents screen, three vendor cards, the mocked verification step, `Check
  again`, `Cancel`, a completed sign-in, Escape, and `Back to chats`.
- `src/main/login.ts` holds the mock path. The mock path emits fixed steps and
  does not load a vendor page.
- `tests/e2e/harness.ts` sets `BLIBS_MOCK_LOGIN=1` and a temporary profile.
- No unit test covers the main-process login controller.

Run the test with:

```sh
npm run e2e
```
