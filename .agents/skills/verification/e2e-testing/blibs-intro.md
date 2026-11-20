# Verify the blibs introduction and harness replies

## Scope and non-goals

This document covers the `@blibs` mention, the generated introduction reply, the
harness list that the panel reports, and the header on a forwarded harness
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

1. Start the mock app. Complete the first-run card. Select `Muse`.
   Expected: the chat composer is enabled.

2. Turn `Codex` off for Muse in the Context column.
   Expected: the switch is off and the panel keeps the choice.

3. Select `Agents`, then `Sign in to Muse`, then `Check again`.
   Expected: the card reports `Signed in to Muse`. Select `Back to chats`.

4. Use the panel composer to send `@blibs What can you do?`.
   Expected: one new Muse message starts with `blibs introduction`. It lists
   `Available harnesses: Claude Code, Codex, OpenCode.` and
   `Enabled for this assistant: Claude Code, OpenCode.` It explains the tag
   rule and says that a tagged task goes to the selected harness. It does not
   describe project selection. It ends with
   `To try it, send @opencode followed by a task.`

5. Turn `OpenCode` off and turn `Codex` on for Muse. Send `@blibs again`.
   Expected: the new reply suggests `To try it, send @codex followed by a task.`

6. Turn every harness off for Muse. Send `@blibs again`.
   Expected: the reply says no harness is enabled and to turn one on in
   Connections. It has no first-task line.

7. Repeat step 4 in the same chat.
   Expected: a second introduction reply appears. The reply to the first
   message does not trigger itself.

8. Use the panel composer to send `@opencode $alpha hi`.
   Expected: the relay runs the fake harness. The reply in the chat starts with
   `Sent from user's harness (OpenCode).` The text `harness reply: hi` follows
   the header.

9. Read the relay status at `http://127.0.0.1:8899/api/relay`.
   Expected: `harnesses` lists the three rows. The `codex` row has
   `"enabled": false`.

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
  covers the mention, the harness list, the disabled row, the tag instructions,
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
