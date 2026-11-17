# Verify onboarding and first run

## Scope and non-goals

This document covers the first-run card, its four steps, Back, Next, Skip,
Escape, the route to the agents screen, and the saved completion state.

It does not cover a real vendor sign-in. Use [vendor-login.md](vendor-login.md)
for the mock sign-in steps. It does not cover chat content or theme tokens.

## Preconditions and setup

- Node.js 24 and `npm ci`.
- A successful `npm run build`.
- A display for `npm run e2e`.
- No vendor account.
- A temporary profile. The harness creates and removes it.

The e2e harness sets `BLIBS_MOCK_LOGIN=1` and a temporary profile and store.
For the interactive checks, use the shared mock app command in the
[guide](README.md#start-a-mock-app).

## Test steps

1. Run `npm run e2e`.
   Expected: exit code 0. The test
   `first run shows onboarding steps and does not reappear` passes. The command
   writes `tests/e2e/artifacts/onboarding-dark.png` and
   `tests/e2e/artifacts/onboarding-light.png`.

2. Start the mock app with the shared command.
   Expected: the first-run card shows before the chat shell. The heading is
   `One window for your personal agents`.

3. Read the `Setup steps` list.
   Expected: the list has four items in this order: `What blibs does`,
   `Connect a vendor`, `Sign in`, `Start`. The first item has
   `aria-current="step"`.

4. Check the first step controls.
   Expected: `Back` is disabled. `Skip` and `Next` are visible.

5. Select `Next`.
   Expected: the heading is `Connect a vendor`. The `Vendor` combobox is
   visible. The options are `Meta Muse`, `OpenAI Dots`, and `xAI Grok`.

6. Select `Back`.
   Expected: the heading is `One window for your personal agents`. `Back` is
   disabled again.

7. Select `Next` two times.
   Expected: the third step heading is `Sign in`. The text shows the selected
   vendor. The primary button is `Sign in to Muse` when Muse is selected.

8. Press `Escape`.
   Expected: the chat shell shows and the first-run card does not show. The
   app saves the completion state.

9. Reset the first-run state from the page console or a CDP client:
   `localStorage.removeItem('blibs-onboarding-v1'); location.reload();`
   Expected: the first-run card shows again.

10. Select `Skip` on the first step.
    Expected: the chat shell shows. The first-run card does not show.

11. Read the saved state:
    `localStorage.getItem('blibs-onboarding-v1')`.
    Expected: the value is `done`.

12. Reload the page.
    Expected: the chat shell shows. The first-run card does not show.

13. Reset the first-run state again. Select `Next` two times, then select
    `Skip`.
    Expected: the card moves to the `Start` step but does not close. This is
    the documented Skip behavior after the first step. Select
    `Start using blibs`.
    Expected: the chat shell shows.

14. Reset the first-run state again. Select `Next` two times, then select
    `Sign in to Muse`.
    Expected: the chat shell state changes to the agents screen. The heading is
    `Agents`. The mock sign-in step shows. This is the onboarding route into
    [vendor-login.md](vendor-login.md).

## Failure signals and artifacts

- The first-run card shows after a completed run or after a reload.
- `Back` is enabled on the first step.
- `Skip` is missing on a setup step.
- Escape does not return to the chat shell.
- The saved key is not `done`.
- The console shows a React error or a storage error.
- A screenshot is missing from `tests/e2e/artifacts/`.

Artifacts:

- `tests/e2e/artifacts/onboarding-dark.png`
- `tests/e2e/artifacts/onboarding-light.png`
- The `npm run e2e` terminal output
- The Electron and panel console output

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Keep the screenshots only for the pull request body. Do not commit
   `tests/e2e/artifacts/`.

## Automated tests that cover it

- `tests/e2e/smoke.spec.ts`, test
  `first run shows onboarding steps and does not reappear`. It covers the card,
  the disabled Back control, Skip, Next, Back, completion, reload persistence,
  and both theme screenshots.
- `tests/e2e/harness.ts` provides `resetOnboarding`, `completeOnboarding`, and
  `ONBOARDING_STORAGE_KEY`. The tests use these helpers.
- `tests/e2e/harness.ts` sets `BLIBS_MOCK_LOGIN=1` and a temporary profile.
- No unit test covers the onboarding component.

Run the test with:

```sh
npm run e2e
```
