# Verify OpenCode project selection

## Scope and non-goals

This document covers the project selection flow for OpenCode. The relay uses
only immediate folders in the configured projects directory. It reuses one
OpenCode session for each project in one chat thread.

It does not cover a real model run or a live vendor session. Use the mock app
and a temporary projects directory.

## Preconditions and setup

Shared setup: see [README.md](README.md).

- Use the shared mock command. It sets `BLIBS_MOCK_LOGIN=1`.
- Start the app with a fake harness and temporary history store.
- Create a temporary projects directory with `alpha` and `beta` subfolders.

## Test steps

1. Start the mock app with the shared command. Set `BLIBS_RELAY_COMMAND` to
   the fake harness command and `BLIBS_RELAY_PROJECTS_DIR` to the temporary
   projects directory. Expected: the panel opens and the relay uses that
   directory.

2. Send a baseline message. Then import `@opencode Build a small app` as an
   assistant message:

   ```sh
   TS=$(( $(date +%s) * 1000 ))
   send_muse() {
     TS=$((TS + 1000))
     curl -s -X POST http://127.0.0.1:8899/api/import \
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

3. Run `send_muse agent project-run '@opencode $alpha Build a small app'`.
   Expected: the harness runs in the `alpha` folder. The outbox reply contains
   `harness reply: Build a small app`.

4. Run `send_muse agent project-follow-up '@opencode $alpha Add a test'`.
   Expected: the harness reuses the session ID from step 3.

5. Run `send_muse agent missing-project '@opencode $missing Build it'`.
   Expected: blibs says that the project does not exist and gives
   `blibs new-project <name>`. The harness does not run.

6. Open the Muse chat in the panel. Expected: the project list and harness
   replies appear once in the thread.

## Failure signals and artifacts

- A task without a project starts the harness.
- The project list includes paths outside the configured directory.
- The selected project does not match the task token.
- A follow-up task starts a new session for the same project and thread.
- An unknown project starts a harness run.
- The panel shows a duplicate project list reply.

Artifact: `tests/e2e/artifacts/project-selection.png`.

## Cleanup

1. Stop the mock app.
2. Remove the temporary directory with `rm -rf "$TMP"`.
3. Do not commit a screenshot, an evidence file, or a note.

## Automated tests that cover it

- `tests/relay.test.ts`: `project matcher lists only immediate folders and resolves names, tokens, and paths`; `a task without a project asks Muse to choose, then runs in the selected project`; `the relay reuses one session per project and thread`; `an unknown project gets the create-project instruction without a harness run`. Run with `node --import tsx --test tests/relay.test.ts`.
- `tests/e2e/smoke.spec.ts`: `the relay asks Muse to choose a project and runs the selected task`. Run with `npm run e2e`.
