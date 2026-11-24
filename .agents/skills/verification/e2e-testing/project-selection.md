# Verify Muse project selection

## Scope

This document covers the project selection flow for OpenCode and Codex in Muse. The relay uses
only immediate folders in the configured projects directory. Each chat and
project can have named sessions for each harness. OpenCode also supports a
legacy session called `Default`. Different projects can
run at the same time. Tasks for the same project run in order.

The relay tests use a harness stub. The live check uses a signed-in Muse
session and the installed harnesses.

## Setup

See [shared setup](README.md#shared-setup).

## Test steps

1. Follow the [authenticated provider workflow](../SKILL.md#authenticated-provider-checks).
   Close any app instance that uses the profile. Use a signed-in Muse profile
   with the current conversation ready in the composer. Set
   `BLIBS_LIVE_PROFILE` if the profile differs from the installed app profile.

   ```sh
   BLIBS_LIVE_LOGIN=1 npm run e2e:live
   ```

   Confirm that Muse sends an OpenCode task. The check verifies the harness
   reply in the same conversation, the exact test bytes in `alpha/hello.txt`,
   and an empty `beta`. The creation test starts with an empty projects
   folder and checks that Muse requests `alpha` before OpenCode writes the
   file. Set `BLIBS_LIVE_CREATION_CHAT` to use another Muse chat URL for the
   creation test.

   The named-session checks for OpenCode and Codex ask for the current commands with `@blibs`. It
   asks Muse to start two sessions in `alpha` and write separate files. It
   checks that Muse resumes by name when asked to continue the work that
   created `first.txt` and verifies that only `first.txt` changes. Set
   `BLIBS_LIVE_MODEL` to an available OpenCode model ID to also ask Muse for
   that model on the first task and check the command it sends. Use
   `BLIBS_LIVE_CODEX_MODEL` for the Codex check. To run only the Codex check
   against the existing build, use this command.

   ```sh
   BLIBS_LIVE_LOGIN=1 node --import tsx --test --test-name-pattern 'Codex named sessions' tests/e2e/live-muse.spec.ts
   ```

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
   It lists `$alpha` and `$beta` and supplies a request ID. The relay waits
   for a selection before it starts the harness.

4. Copy the request ID into `REQUEST_ID`. Run
   `send_muse agent project-choice "@opencode /select $REQUEST_ID \$alpha"`.
   Expected: blibs lists the sessions for `alpha`. No harness run starts.
   Run `send_muse agent project-run '@opencode /new $alpha app Build a small app'`.
   Expected: OpenCode creates a session in `alpha`. blibs saves its ID and
   announces `app`. The outbox reply contains `harness reply: Build a small app`.

5. Run `send_muse agent project-follow-up '@opencode /resume $alpha app Add a test'`.
   Expected: blibs announces the name `app` and the harness reuses its session.

6. Run `send_muse agent missing-project '@opencode $missing Build it'`.
   Expected: blibs says that the project is unavailable and offers the
   available project IDs. The harness does not run.

7. Open the Muse chat in the panel. Expected: the project list and harness
   replies appear once in the thread.

8. Open **Connections** and select **New project**. Create `picker-test`.
   The picker selects the new project, and the shared folder contains an
   empty `picker-test` folder.

9. Open **Settings → Harness models**. Confirm OpenCode shows **Harness
   default** when the field is blank. Save `provider/custom`, reopen
   Settings, and confirm the value. Clear the field and save to restore the
   harness default. Use a mock profile for these changes.

10. In the mock app, send
    `@opencode /resume $alpha app --model provider/custom Add a test`.
    Confirm the reply contains only the task as its prompt. The relay tests
    check that OpenCode gets the model option for that run and uses the
    configured default on the next run without an option.

11. In the scripted Muse test, the mock harness lists two model IDs ending in
    `sol`. Send the task that asks for `sol`. Confirm that blibs returns the
    exact IDs and the scripted assistant sends the same task with one of them.
    The session starts after the retry. The relay tests also cover a retry
    with an existing session.

12. In **Connections**, turn off **Codex for Muse** and confirm that
    **OpenCode for Muse** is still on. Reload and check that the settings
    persist. In **Settings → Harness models**, save and clear the Codex
    default and confirm that the OpenCode field keeps its value.

## Diagnostics

- Check whether the harness reply appeared in the same conversation.
- Check whether the file exists, its bytes match, and `beta` is empty.

The live check stops Electron and removes its temporary projects when it ends. Use the shared cleanup steps for the manual mock app.

## Automated coverage

- The Codex test in `tests/relay.test.ts` checks project commands, exact
  model IDs, session isolation, resume after restart, final replies, and
  failure notes through the Muse import and outbox routes.
- `tests/relay.test.ts` covers explicit session commands, project selection replies, duplicate
  delivery, stale choices, ambiguous requests, and unknown and empty project
  lists, folder creation, invalid names, conflicts, and write failures. The
  parallel run test holds one project open while a second project completes.
  It then checks that a follow-up waits and reuses its session. Run with
  `node --import tsx --test tests/relay.test.ts`.
- The relay named-session test starts two sessions in one project, rejects
  ambiguous, unknown, and wrong-project selections, and checks that both
  named sessions and the default session can resume after restart. It
  checks the name list and confirms that previously issued IDs still work.
  The noisy-output test checks that both a new and resumed run send only
  the final reply, even after a large tool event. It also checks that the full final reply is
  queued when it exceeds 256 KiB. Another test checks that a failure before OpenCode reports its ID leaves
  the name available and that a recorded ID survives a later failure.
- `tests/e2e/smoke.spec.ts` checks picker creation and scripted Muse
  creation, continuation, and redelivery. The named-session test checks the
  composer through two new sessions and a resume, including file contents
  and the session IDs passed to the mock harness. It checks the model choices
  and retry from the composer. It also checks that Settings
  saves and clears the model default. Run with `npm run e2e`.
- `tests/e2e/live-muse.spec.ts` checks the provider composer, relay, and file contents in step 1.
