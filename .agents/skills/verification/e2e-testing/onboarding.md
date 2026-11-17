# Verify onboarding and first run

## Scope and non-goals

This document covers the first-run card, its four steps, Back, Next, Skip,
Escape, the route to the agents screen, and the saved completion state.

It does not cover a real vendor sign-in. Use [vendor-login.md](vendor-login.md)
for the mock sign-in steps. It does not cover chat content or theme tokens.

## Preconditions and setup

Shared setup: see [README.md](README.md).

- A fresh profile with no `blibs-onboarding-v1` key. The shared command starts
  a new profile.

## Test steps

1. Start the mock app with the shared command.
   Expected: the first-run card shows before the chat shell. The heading is
   `One window for your personal agents`.

2. Read the `Setup steps` list and the controls.
   Expected: the list has `What blibs does`, `Connect a vendor`, `Sign in`, and
   `Start`. The first item has `aria-current="step"`. `Back` is disabled.
   `Skip` and `Next` are visible.

3. Select `Next`.
   Expected: the heading is `Connect a vendor`. The `Vendor` combobox offers
   `Meta Muse`, `OpenAI Dots`, and `xAI Grok`. Select `Back`.
   Expected: the first heading returns and `Back` is disabled again.

4. Select `Next` two times, then press `Escape`.
   Expected: the third heading is `Sign in` with the selected vendor. Escape
   returns to the chat shell and saves the completion state.

5. Reset the first-run state, then select `Skip` on the first step:

   ```js
   localStorage.removeItem('blibs-onboarding-v1'); location.reload();
   ```

   Expected: the first-run card returns. Skip shows the chat shell. The saved
   value is `done`. A reload does not show the card again.

6. Reset the state again, select `Next` two times, then select `Skip`.
   Expected: the card moves to the `Start` step and stays open. Select
   `Start using blibs`. Expected: the chat shell shows.

7. Reset the state again, select `Next` two times, then select
   `Sign in to Muse`.
   Expected: the agents screen shows the mock sign-in step. Continue with
   [vendor-login.md](vendor-login.md).

## Failure signals and artifacts

- The first-run card shows after completion or after a reload.
- `Back` is enabled on the first step, or `Skip` is missing.
- Escape does not return to the chat shell.
- The saved key is not `done`.
- The console shows a React or storage error.
- A screenshot is missing from `tests/e2e/artifacts/`.

Artifacts: `tests/e2e/artifacts/onboarding-dark.png` and
`onboarding-light.png`.

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Keep screenshots only for the pull request body.

## Automated tests that cover it

`tests/e2e/smoke.spec.ts`, test
`first run shows onboarding steps and does not reappear`, covers the card, the
disabled Back control, Skip, Next, Back, completion, reload persistence, and
both theme screenshots. `tests/e2e/harness.ts` provides `resetOnboarding`,
`completeOnboarding`, and `ONBOARDING_STORAGE_KEY`. No unit test covers the
onboarding component.

Run the check with:

```sh
npm run e2e
```
