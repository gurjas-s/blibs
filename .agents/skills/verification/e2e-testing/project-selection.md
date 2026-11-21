# Verify OpenCode project selection

## Scope

This document covers the project selection flow for OpenCode. The relay uses
only immediate folders in the configured projects directory. It reuses one
OpenCode session for each project in one chat thread.

The automated composer check uses scripted Muse responses and a harness stub.
The optional live check uses a signed-in Muse session and OpenCode.

## Setup

See [shared setup](README.md#shared-setup).

## Test steps

1. Run the scripted composer check from the repository root after the build.

   ```sh
   node --import tsx --test --test-name-pattern='scripted Muse creates' tests/e2e/smoke.spec.ts
   ```

   Confirm that the test passes. It checks that both projects stay empty
   until Muse sends the short selection reply. The harness reply then appears
   in the same conversation, `alpha/hello.txt` contains exactly
   `Hello from blibs.`, and `beta` stays empty. The creation scenario starts
   with an empty projects directory. It checks that Muse creates `alpha`,
   uses the short selection reply to resume the task, and keeps the file
   intact when Muse repeats the creation command.

2. For the opt-in live check, follow the
   [authenticated provider workflow](../SKILL.md#authenticated-provider-checks).
   Use a signed-in profile. With the app
   built and OpenCode configured, run the following command. Set `BLIBS_LIVE_PROFILE` if the signed-in profile differs from the
   installed app profile.

   ```sh
   BLIBS_LIVE_LOGIN=1 node --import tsx --test --test-name-pattern='live Muse creates a file' tests/e2e/live-login.spec.ts
   ```

   Confirm that Muse sends its own OpenCode task. The check verifies the
   harness reply in the same conversation, the exact test bytes in
   `alpha/hello.txt`, and an empty `beta`.

   To check creation with a live provider, run the following command. It uses
   the current Muse chat. Set `BLIBS_LIVE_CREATION_CHAT` to use another Muse
   chat URL.

   ```sh
   BLIBS_LIVE_LOGIN=1 node --import tsx --test --test-name-pattern='live Muse creates a project' tests/e2e/live-login.spec.ts
   ```

   Confirm that Muse creates `alpha` from an empty projects directory and
   that OpenCode writes the exact bytes. Check that both replies reach the
   same conversation.

3. Start the mock app with the shared command. Expected: the panel opens.

4. Send a baseline message. Then import `@opencode Build a small app` as an
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
   It lists `$alpha` and `$beta` and supplies a request ID. The relay does
   not start the harness.

5. Copy the request ID from the reply into `REQUEST_ID`. Run
   `send_muse agent project-run "@opencode /select $REQUEST_ID \$alpha"`.
   Expected: the harness runs in the `alpha` folder. The outbox reply contains
   `harness reply: Build a small app`.

6. Run `send_muse agent project-follow-up '@opencode $alpha Add a test'`.
   Expected: the harness reuses the session ID from step 5.

7. Run `send_muse agent missing-project '@opencode $missing Build it'`.
   Expected: blibs says that the project is unavailable and offers the
   available project IDs. The harness does not run.

8. Open **Connections** and select **New project**. Create a folder named
   `picker-test`. The picker selects the new project, and the configured
   projects directory contains an empty `picker-test` folder.

9. Open the Muse chat in the panel. Expected: the project list and harness
   replies appear once in the thread.

## Diagnostics

- Check whether the harness reply appeared in the same conversation.
- Check whether the file exists, its bytes match, and `beta` is empty.

Artifacts are `project-selection.png`, `new-project-dark.png`, and
`new-project-light.png` in `tests/e2e/artifacts/`.

The composer checks stop Electron and remove their temporary projects when
they end. Use the shared cleanup steps for the manual mock app.

## Automated coverage

- `tests/relay.test.ts` covers direct tasks, short selection replies, duplicate
  delivery, stale choices, ambiguous requests, and unknown and empty project
  lists, folder creation, duplicate delivery, invalid names, conflicts, and
  write failures. Run with `node --import tsx --test tests/relay.test.ts`.
- `tests/e2e/smoke.spec.ts`: `the relay asks Muse to choose a project and runs the selected task`. Run with `npm run e2e`.
- `tests/e2e/smoke.spec.ts` includes `scripted Muse creates a file in the requested project from the composer`. Run step 1.
- `tests/e2e/live-login.spec.ts` includes `live Muse creates a file in the requested project from the composer`. Run step 2 for the opt-in check.
