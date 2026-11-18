# Relay loop

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

One new inbound agent message starts one harness run. The reply becomes one
outbox item for the same provider. The main process delivers it with the
existing outbox loop.

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

## OpenCode invocation

This repository uses `opencode` v2.3.0. The verified command is:

```sh
BLIBS_HARNESS_CMD='opencode run --model opencode-go/deepseek-v4.1-flash --archived'
```

blibs appends the prompt as the last argument. It starts the command without a
shell, in `BLIBS_HARNESS_CWD`, with stdin closed. `opencode run` prints the final
assistant text on stdout and the banner and tool traces on stderr. blibs reads
stdout, strips color codes, trims, and caps the reply at 4,000 characters. It
does not keep stderr, because it can repeat the prompt.

The default `opencode run` command uses your configured default model. A failed
run records an error and queues nothing.

## What starts a run

A row must meet all conditions:

- The import inserted a new row. An update or a duplicate does not count.
- The role is `agent`. A user message and a typed relay reply do not count.
- The provider is `BLIBS_RELAY_PROVIDER`.
- The thread is a provider page. A root path counts only after a user turn.
  Muse keeps chats at `https://muse.ai/`; its signed-out page has no user turn.
- The conversation had a baseline. The first import batch is history, so a
  sign-in sync does not relay stored rows.
- The message ID is not in the processed set.
- The timestamp is later than the high-water mark.
- The queue is not full.

The high-water mark, the processed IDs, and the known conversations are in
`<data>/relay-state.json`. A restart does not replay history. A run that was
active during a shutdown is recorded as an error on the next start.

Limits: one run at a time; 20 queued messages; a 2,000-character prompt; a
4,000-character reply; 64 KB of stdout. The harness gets an environment without
`EMAIL_MUSE`, `PASSWORD_MUSE`, and `PROTON_URL`, and a separate process group
that blibs kills on timeout and on server shutdown.

## Status

`GET /api/relay` uses the same local-host and origin checks as the other routes.
It returns:

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
code or message, such as `harness timed out after 120000 ms`. Status has no
message body, prompt, harness output, or credential value.

## Tests

`tests/relay.test.ts` uses a fake harness command, temporary data directories,
and mocked import rows. It covers accepted and rejected rows, baseline, failure,
timeout, restart, and status redaction. Run it with `npm test`. The tests never
start real OpenCode and never touch a vendor session.

## Manual proof on a real session

Use your own accounts. Read the credentials from `.env`. Do not paste a value in
a command, a log, or a commit.

1. `set -a; . ./.env; set +a`
2. `export BLIBS_RELAY=1`
   `export BLIBS_RELAY_PROVIDER=muse`
   `export BLIBS_HARNESS_CMD='opencode run --model opencode-go/deepseek-v4.1-flash --archived'`
   `export BLIBS_HARNESS_CWD="$(mktemp -d)/blibs-harness"`
   `export BLIBS_DATA_DIR="$(mktemp -d)/blibs-data"`
3. `npm run build`, then `npm start`.
4. Use **Agents**, then **Sign in to Muse**.
5. If Muse asks for a code, open `PROTON_URL` and sign in with the same
   `EMAIL_MUSE` and `PASSWORD_MUSE`. Read the code and finish the sign-in.
6. Send one message to Muse. Muse answers with an agent message.
7. `curl http://127.0.0.1:8787/api/relay` shows the run move from `running` to
   `ok`.
8. `curl http://127.0.0.1:8787/api/outbox` shows the reply move from `queued` to
   `sent`.
9. The harness reply appears in the Muse chat with the `You:` label. Muse can
   answer it and start another run. Quit the app to end the loop.

If a vendor gate blocks the sign-in (CAPTCHA, provider policy, or a missing
code), stop at the gate. Do not loop. Record the gate and the failed step. The
automated tests must still pass.
