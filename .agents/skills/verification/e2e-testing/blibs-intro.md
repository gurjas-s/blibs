# Verify the blibs introduction and harness replies

## Scope and non-goals

This document covers the `@blibs` mention, the generated introduction reply, the
harness list that the relay supports, and the header on a forwarded harness
reply.

It does not cover a real model run, a real coding task, or a live vendor
session. The live sign-in check is a separate opt-in command.

## Preconditions and setup

Shared setup: see [README.md](README.md).

- Use the shared mock command. It sets `BLIBS_MOCK_LOGIN=1`.
- The relay uses a temporary data directory and the fake harness from
  `tests/e2e/harness.ts`. No model runs.
- Set `BLIBS_RELAY_PROJECTS_DIR` to a temporary directory with one folder
  named `alpha`.

## Test steps

1. Run the two mock checks with a display.

   ```sh
   npm run build
   node --import tsx --test --test-name-pattern='an @blibs mention|Connections applies the saved folder' tests/e2e/smoke.spec.ts
   ```

   Expected result. Both checks pass. The enabled introduction lists OpenCode
   as available and enabled. It suggests `@opencode`. The disabled
   introduction lists OpenCode as available and says no harness is enabled.
   The harness reply starts with `Sent from user's harness (OpenCode).`.

## Failure signals and artifacts

- The `@blibs` message adds no reply.
- The reply lists a disabled harness as enabled.
- The reply suggests a disabled harness.
- A reply with no enabled harness has a first-task line.
- A harness reply has no header, or the header is not the first line.
- A project selection message has no harness header.
- The relay starts a harness run for the introduction reply.
- The relay status has an empty `harnesses` list after the panel loads.

Artifacts: `tests/e2e/artifacts/blibs-intro.png` and
`tests/e2e/artifacts/harness-reply.png`.

## Cleanup

1. Quit the app.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Do not commit a screenshot, an evidence file, or a note.

## Automated tests that cover it

- `tests/e2e/smoke.spec.ts`, test
  `an @blibs mention shows the introduction and a harness reply says which harness sent it`
  covers the mention, the supported harness list, the tag instructions,
  and the header.
- `tests/relay.test.ts`, test `project replies ask the assistant to choose,
  and the blibs introduction explains routing`, covers the updated
  introduction and project reply.
- `tests/e2e/live-login.spec.ts`, test
  `live Muse sign-in with an email code and the @blibs introduction` is an
  opt-in live check. It needs `BLIBS_LIVE_LOGIN=1` and account values in the
  ignored `.env` file. It does not run in CI.
- The project selection check is in
  [project-selection.md](project-selection.md).

Run the mock checks with:

```sh
npm run e2e
npm test
```

Run the live check with:

```sh
BLIBS_LIVE_LOGIN=1 npm run e2e:live
```
