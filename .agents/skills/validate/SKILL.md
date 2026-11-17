---
name: validate
description: Check a blibs change before review. Run lint, unit tests, the e2e smoke spec, and one manual test. Add a screenshot when the change is visible.
---

# Validate a change

Run these steps in this order from the repository root.

## 1. Build

Run `npm run build`.

The command must pass.

## 2. Lint

Run `npm run lint`.

The command must pass with no warnings.

## 3. Unit tests

Run `npm test`.

The command must pass.

A failing test is acceptable only when the unit that the change modifies is
the cause of the failure. Do not accept a failure in another unit. Write the
failure, the cause, and the plan in the PR.

## 4. End-to-end test

Run `npm run e2e` when the change affects the panel, the app startup path, or
the backend health route.

The command builds the app, starts Electron with a remote debugging port, and
runs the smoke spec through `playwright-core` over CDP. It writes a screenshot
to `tests/e2e/artifacts/panel.png`.

The check needs a display. On Linux without `DISPLAY` or `WAYLAND_DISPLAY`, the
spec skips with a message. Use `xvfb-run -a npm run e2e` on a headless Linux
machine.

## 5. Manual test

Do one manual test of the changed behavior.

Write these items in the PR:

1. The steps that you ran.
2. The result that you saw.

## 6. Screenshot

If the change changes what a user sees, add a screenshot to the PR.

## 7. PR text

Write the PR title, PR description, review comments, commit messages, and
user-facing docs in English. Use ASD-STE100 Simplified Technical English.
Use short sentences. Use active voice. Put one idea in each sentence.
