# Verify the blibs introduction and harness replies

## Scope

This document covers the `@blibs` mention, the generated introduction reply, the
harness list that the relay supports, and the header on a forwarded harness
reply.

## Test steps

Run the `an @blibs mention` smoke check using the
[shared test command](README.md#shared-setup). With OpenCode enabled, the
introduction lists it as available and enabled and suggests `@opencode`.
With OpenCode disabled, the introduction says no harness is enabled.
A forwarded reply starts with `Sent from user's harness (OpenCode).`.

For the saved folder and harness settings, see
[Connections](connections-chat.md#automated-coverage).

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
