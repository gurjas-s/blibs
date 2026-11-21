# Verify the blibs introduction and harness replies

## Scope

This document covers the `@blibs` mention, the generated introduction reply, the
harness list that the relay supports, and the header on a forwarded harness
reply.

Use the shared mock session for the steps below.

## Setup

See [shared setup](README.md#shared-setup).

## Test steps

1. Run the two mock checks with a display after building the app.

   ```sh
   node --import tsx --test --test-name-pattern='an @blibs mention|Connections applies the saved folder' tests/e2e/smoke.spec.ts
   ```

   Expected result. Both checks pass. The enabled introduction lists OpenCode
   as available and enabled. It suggests `@opencode`. The disabled
   introduction lists OpenCode as available and says no harness is enabled.
   The harness reply starts with `Sent from user's harness (OpenCode).`.

## Diagnostics

- The relay starts a harness run for the introduction reply.

Smoke screenshots: `blibs-intro.png` and `harness-reply.png`.

## Automated coverage

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

See the [authenticated workflow](../SKILL.md#authenticated-provider-checks) for live checks.
