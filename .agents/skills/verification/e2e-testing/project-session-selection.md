# Verify project and session selection

## Scope and non-goals

This document covers the provider command flow for one harness. A user
`@opencode` tag is ignored; only the provider assistant can send these commands.

- `@opencode` lists the projects that blibs knows about.
- `@opencode $sessions $<project>` lists the sessions of one project. The
  shorter `@opencode $<project>` form also works.
- `@opencode $<project>-<sessionid> <task>` continues one session.
- `@opencode $<project>-new <task>` starts a new session.
- `@opencode $find-project` lists projects from the home-folder search.
- `@opencode $find-project <task>` sends the task to the routing agent.

It does not cover a real vendor login, a real model run, or a live coding
task. Use the mock app and a temporary store.

## Preconditions and setup

Shared setup: see [README.md](README.md).

- Use the shared mock command. It sets `BLIBS_MOCK_LOGIN=1`.
- Set `BLIBS_RELAY_COMMAND` to a fake harness that answers the routing prompt
  with one found project and answers a work prompt with a fixed text.
- Set `BLIBS_RELAY_SESSION_COMMAND` to a command that prints a JSON session
  list. The command receives the project folder as its working directory.
- Set `BLIBS_RELAY_SEARCH_ROOT` to a temporary home folder. Add one project
  marker, for example `$TMP/home/alpha/.git`.
- The relay uses one registered project. The project folder name becomes the
  `$` token.

Create the fake harness and the found project:

```sh
mkdir -p "$TMP/home/alpha/.git"
cat > "$TMP/fake-harness.mjs" <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--session-list') {
  process.stdout.write(JSON.stringify([
    { id: 'ses_demo', title: 'Demo session', updated: Date.now() },
  ]));
  process.exit(0);
}
const dir = path.dirname(new URL(import.meta.url).pathname);
const prompt = args.at(-1) || '';
if (prompt.includes('blibs routing agent')) {
  process.stdout.write('FORWARD ' + fs.readFileSync(path.join(dir, 'route.txt'), 'utf8').trim() + '\n');
} else {
  process.stdout.write('harness reply: ' + (prompt.split('\n').at(-1) || '') + '\n');
}
EOF
echo "$TMP/home/alpha" > "$TMP/route.txt"
```

Add this import helper to the shell:

```sh
TS=$(( $(date +%s) * 1000 + 1000 ))
send_muse() {
  TS=$((TS + 1000))
  curl -s -X POST "http://127.0.0.1:8899/api/import" \
    -H 'Content-Type: application/json' \
    -d "{\"items\":[{\"provider\":\"muse\",\"role\":\"user\",\"url\":\"https://muse.ai/chat/select\",\"sourceId\":\"$1\",\"ts\":$TS,\"text\":\"$2\"}]}"
}
```

## Test steps

1. Start the mock app with the shared command. Add these values:

   ```sh
   BLIBS_RELAY_COMMAND="[\"$(command -v node)\",\"$TMP/fake-harness.mjs\"]"
   BLIBS_RELAY_SESSION_COMMAND="[\"$(command -v node)\",\"$TMP/fake-harness.mjs\",\"--session-list\"]"
   BLIBS_RELAY_SEARCH_ROOT="$TMP/home"
   ```

   Expected: the panel shows the chat shell.

2. Set one registered project:

   ```sh
   curl -s -X POST "http://127.0.0.1:8899/api/relay/projects" \
     -H 'Content-Type: application/json' \
     -d '{"projects":["'"$TMP"'/project-alpha"],"discoveryRoot":"'"$TMP"'/empty"}'
   ```

   Expected: the response has `project-alpha` in `projects`.

3. Send one baseline message and one bare `@opencode` message:

   ```sh
   send_muse base 'E2E choices baseline.'
   send_muse projects '@opencode'
   curl -s "http://127.0.0.1:8899/api/outbox"
   ```

   Expected: the newest outbox item starts with `blibs choices`. It lists
   `$project-alpha` and no filesystem path. No harness run starts.

4. Send the session-list command:

   ```sh
   send_muse sessions '@opencode $sessions $project-alpha'
   curl -s "http://127.0.0.1:8899/api/outbox"
   ```

   Expected: the newest outbox item starts with `blibs choices`. It lists
   `$project-alpha-ses_demo`. The title `Demo session` is present.

5. Send the session choice with a task:

   ```sh
   send_muse run '@opencode $project-alpha-ses_demo Do the chosen work'
   curl -s "http://127.0.0.1:8899/api/outbox"
   ```

   Expected: the newest work reply starts with
   `Sent from user's harness (OpenCode).` and contains
   `harness reply: Do the chosen work`.

6. Send the home search:

   ```sh
   send_muse find '@opencode $find-project'
   curl -s "http://127.0.0.1:8899/api/outbox"
   ```

   Expected: the newest outbox item starts with `blibs choices` and lists the
   project in `$TMP/home`.

7. Send the home search with a task:

   ```sh
   send_muse find-run '@opencode $find-project Do the home work'
   curl -s "http://127.0.0.1:8899/api/relay"
   ```

   Expected: the routing agent runs and then the work run starts in the found
   project. `lastRun.state` is `ok`.

8. Reload the panel and select `Muse`.
   Expected: the panel shows the `blibs choices` replies as agent messages.
   The chat does not start another run.

## Failure signals and artifacts

- A bare `@opencode` starts a harness run.
- The project list has no `$` token.
- The project list shows a filesystem path.
- The session list has no session id or no title.
- A session choice starts the routing agent.
- A new session choice uses the old session id.
- `$find-project` searches the registry instead of the home folder.
- A choice reply retriggers itself.
- A reload starts a run.

Artifacts: `tests/e2e/artifacts/project-session-choices.png`.

## Cleanup

1. Quit the mock app.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Do not commit a screenshot, an evidence file, or a note.

## Automated tests that cover it

- `tests/e2e/smoke.spec.ts`, test
  `the relay lists projects and sessions and runs a chosen session` covers the
  project list, the session list, the direct session run, and the panel view.
- `tests/relay.test.ts`, tests
  `a bare @opencode lists the known projects and starts no run`,
  `a session choice continues one OpenCode session without the routing agent`,
  `a new session choice creates one session and runs the task`,
  `find-project lists the home search and routes a task to a found project`,
  `a found project keeps its token when the registry has the same folder name`,
  `a bare @opencode in the first batch lists projects without running work`,
  `the choice protocol parses projects, sessions, new sessions, and the fallback`,
  `duplicate project names get stable unique tokens`,
  `the choice replies show the tokens and never ask for a plain task`,
  `the home-folder search finds marked projects and skips heavy folders`, and
  `the router MCP answers tool calls`.
- `tests/e2e/live-login.spec.ts`, test
  `live popout: ignore a user tag, list projects, list sessions, and start a new session`
  is an opt-in live check. It needs `BLIBS_LIVE_LOGIN=1` and an authenticated
  app profile. It checks that a user harness tag is ignored, then runs the real
  OpenCode command for a provider choice. It does not run in CI.

Run the mock checks with:

```sh
npm test
npm run e2e
```

Run the live check with:

```sh
BLIBS_LIVE_LOGIN=1 node --import tsx --test \
  --test-name-pattern "list projects, list sessions" \
  tests/e2e/live-login.spec.ts
```
