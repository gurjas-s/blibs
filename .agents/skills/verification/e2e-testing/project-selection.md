# Verify OpenCode project selection

## Scope

This document covers the project selection flow for OpenCode. The relay uses
only immediate folders in the configured projects directory. It reuses one
OpenCode session for each project in one chat thread.

The relay tests use a harness stub. The live check uses a signed-in Muse
session and OpenCode.
Add a check with an empty project list after [issue #39](https://github.com/gurjas-s/blibs/issues/39)
adds provider-led project creation.

## Setup

See [shared setup](README.md#shared-setup).

## Test steps

1. Follow the [authenticated provider workflow](../SKILL.md#authenticated-provider-checks).
   Close any app instance that uses the profile. Use a signed-in Muse profile
   with a dedicated test conversation ready in the composer. Set
   `BLIBS_LIVE_PROFILE` if the profile differs from the installed app profile.

   ```sh
   BLIBS_LIVE_LOGIN=1 npm run e2e:live
   ```

   Confirm that Muse sends an OpenCode task. The check verifies the harness
   reply in the same conversation, the exact test bytes in `alpha/hello.txt`,
   and an empty `beta`.

2. Start the mock app with the shared command. Expected: the panel opens.

3. Send a baseline message. Then import `@opencode Build a small app` as an
   assistant message:

   ```sh
   TS=$(( $(date +%s) * 1000 ))
   send_muse() {
     TS=$((TS + 1000))
     curl -s -X POST "$BLIBS_BACKEND_URL/api/import" \
       -H 'Content-Type: application/json' \
       -d "{\"items\":[{\"provider\":\"muse\",\"role\":\"$1\",\"url\":\"https://muse.ai/chat/project-check\",\"sourceId\":\"$2\",\"ts\":$TS,\"text\":\"$3\"}]}"
   }
   send_muse user baseline 'Project selection baseline.'
   send_muse agent project-list '@opencode Build a small app'
   ```

   Expected: the newest outbox message says `Pick a project for your task:`.
   It lists `$alpha` and `$beta`. It says
   `Reply with @opencode $<project> <task>.` The relay does not start the
   harness.

4. Run `send_muse agent project-run '@opencode $alpha Build a small app'`.
   Expected: the harness runs in the `alpha` folder. The outbox reply contains
   `harness reply: Build a small app`.

5. Run `send_muse agent project-follow-up '@opencode $alpha Add a test'`.
   Expected: the harness reuses the session ID from step 4.

6. Run `send_muse agent missing-project '@opencode $missing Build it'`.
   Expected: blibs says that the project does not exist and gives
   `blibs new-project <name>`. The harness does not run.

7. Open the Muse chat in the panel. Expected: the project list and harness
   replies appear once in the thread.

## Diagnostics

- Check whether the harness reply appeared in the same conversation.
- Check whether the file exists, its bytes match, and `beta` is empty.

The live check stops Electron and removes its temporary projects when it ends. Use the shared cleanup steps for the manual mock app.

## Automated coverage

- `tests/relay.test.ts`: `project matcher lists only immediate folders and resolves names, tokens, and paths`; `a task without a project asks Muse to choose, then runs in the selected project`; `the relay reuses one session per project and thread`; `an unknown project gets the create-project instruction without a harness run`. Run with `node --import tsx --test tests/relay.test.ts`.
- `tests/e2e/live-muse.spec.ts` checks the provider composer, relay, and file contents in step 1.
