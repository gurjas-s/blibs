# Relay loop

The relay loop connects Muse to a local OpenCode harness through blibs:

```
Muse agent message
        |
        v
blibs import store  (POST /api/import)
        |
        v
relay service  (server/relay.ts)
        |
        v
OpenCode CLI  (server/harness.ts, scratch directory)
        |
        v
existing send outbox  (POST /api/outbox, same provider)
        |
        v
main-process outbox delivery types the reply into the Muse view
```

The relay has one rule: one new inbound agent message starts one harness run.
The harness reply becomes one outbox item for the same provider. The main
process delivers that item with the existing outbox loop. The relay does not
have a second vendor delivery path.

## Configuration

Set these keys in the environment that starts the app. `.env.example` lists
them empty. The app does not print them.

| Key | Default | Meaning |
|---|---|---|
| `BLIBS_RELAY` | off | `1`, `true`, `yes`, or `on` enables the relay. |
| `BLIBS_RELAY_PROVIDER` | `muse` | Only messages from this provider can start a run. |
| `BLIBS_HARNESS_CMD` | `opencode run` | Command line for the harness. blibs splits it and runs no shell. A JSON string array keeps paths with spaces valid. |
| `BLIBS_HARNESS_CWD` | `<data>/harness` | Scratch directory for the harness. blibs refuses a directory inside the blibs checkout and uses `<data>/harness` instead. |
| `BLIBS_RELAY_TIMEOUT_MS` | `120000` | Run timeout. The range is 1,000 to 600,000 ms. |

The data directory is Electron's user-data `history` directory. Set
`BLIBS_DATA_DIR` to override it.

## Verified OpenCode invocation

This repository uses `opencode` v2.3.0. The verified non-interactive command on
this machine is:

```sh
opencode run --model opencode-go/deepseek-v4.1-flash --archived "<prompt>"
```

Set `BLIBS_HARNESS_CMD` to that prefix, without the prompt:

```sh
BLIBS_HARNESS_CMD='opencode run --model opencode-go/deepseek-v4.1-flash --archived'
```

The adapter starts the command without a shell, in `BLIBS_HARNESS_CWD`, with
stdin closed. The prompt is the last argument. `opencode run` prints the final
assistant text on stdout. It prints the model banner and tool traces on stderr.
blibs reads stdout, strips terminal color codes, trims the result, and caps it
at 4,000 characters, the outbox limit. blibs does not keep stderr, because it
can repeat the prompt.

The default `opencode run` command uses your configured default model. If the
run fails, blibs records the failure and queues nothing. It does not invent a
reply.

## What starts a run

A row must meet all these conditions:

- The import inserted a new row. An update or a duplicate does not count.
- The role is `agent`. A user message and a typed relay reply do not count.
- The provider is `BLIBS_RELAY_PROVIDER`.
- The thread is a conversation page below the vendor root, not the vendor
  landing page. The vendor view scrapes marketing articles as agent text
  when it is signed out.
- The message ID is not in the processed set.
- The timestamp is later than the durable high-water mark.
- The conversation is not new. The first import batch of a conversation is
  its baseline, so a sign-in sync does not relay stored history.
- The queue is not full.

The first enabled start sets the high-water mark to the start time. Messages
that are already stored are backlog. Messages that arrive later can start a
run. The mark, the processed IDs, and the known conversations are in
`<data>/relay-state.json`. A restart does not replay history. A run that was
active during a shutdown is recorded as an error on the next start.

Limits:

- One harness run at a time.
- Up to 20 queued messages. A message beyond the limit is dropped and recorded
  as `skipped`.
- The prompt keeps the first 2,000 characters of the message.
- The reply keeps the first 4,000 characters.
- 64 KB of harness stdout is the maximum. A larger stream stops the run.

The harness gets a copy of the environment without `EMAIL_MUSE`,
`PASSWORD_MUSE`, and `PROTON_URL`. It gets a separate process group. blibs kills
the group on timeout and on server shutdown.

## Status

`GET /api/relay` uses the same local-host and origin checks as the other
routes. It returns:

```json
{
  "enabled": true,
  "provider": "muse",
  "harness": {
    "command": "opencode run --model opencode-go/deepseek-v4.1-flash --archived",
    "cwd": "/path/to/scratch/harness",
    "timeoutMs": 120000
  },
  "pending": 0,
  "running": false,
  "processed": 1,
  "watermark": 1760000000000,
  "lastRun": {
    "state": "ok",
    "messageId": "…",
    "startedAt": 1760000000000,
    "endedAt": 1760000000500
  }
}
```

`lastRun.state` is `running`, `ok`, `error`, or `skipped`. An error is a short
code or message, such as `harness timed out after 120000 ms`. Status never
contains a message body, a prompt, the harness output, or a credential value.

## Test the automated path

`tests/relay.test.ts` uses a fake harness command, temporary data directories,
and mocked import rows. It covers:

- one new Muse agent message -> one run -> one Muse outbox item
- a user message does not trigger
- a duplicate import does not trigger
- backlog before start and older messages do not trigger
- a harness failure records an error and queues nothing
- a timeout kills the run and queues nothing
- a restart does not replay
- status and the harness environment contain no credentials

Run it with the rest of the suite:

```sh
npm test
```

The tests never start real OpenCode and never touch a vendor session.

## Manual proof on a real session

Use your own accounts. Read the credentials from `.env`. Do not paste a value in
a command, a log, or a commit.

1. Load the keys into the shell without printing them:
   `set -a; . ./.env; set +a`
2. Export the relay configuration. Use a scratch directory:
   `export BLIBS_RELAY=1`
   `export BLIBS_RELAY_PROVIDER=muse`
   `export BLIBS_HARNESS_CMD='opencode run --model opencode-go/deepseek-v4.1-flash --archived'`
   `export BLIBS_HARNESS_CWD="$(mktemp -d)/blibs-harness"`
   `export BLIBS_DATA_DIR="$(mktemp -d)/blibs-data"`
3. Run `npm run build`, then `npm start`.
4. Use **Agents**, then **Sign in to Muse**. Complete the sign-in.
5. If Muse asks for a verification code, open `PROTON_URL`. Sign in with the
   same `EMAIL_MUSE` and `PASSWORD_MUSE`. Read the code. Complete the sign-in.
6. Open the Muse chat. Send one message to Muse. Muse answers with an agent
   message.
7. Check `curl http://127.0.0.1:8787/api/relay`. The last run changes from
   `running` to `ok`.
8. Check `curl http://127.0.0.1:8787/api/outbox`. The reply item changes from
   `queued` to `sent` after the next outbox drain.
9. Check the Muse chat. The harness reply is a user message.

If a vendor gate blocks the sign-in (CAPTCHA, provider policy, or a missing
verification code), stop at the gate. Do not try again in a loop. Record the
gate and the step that failed. The automated tests must still pass.
