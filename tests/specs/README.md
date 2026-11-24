# TLA+ specifications

Install Java 11 or later and make sure `java -version` works. Download
[`tla2tools.jar` from TLA+ v1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)
and save it as `tests/specs/.tlc/tla2tools.jar`. Create the `.tlc` directory
if necessary.

From the repository root, run:

```sh
npm run test:specs
```

## Models

[MentionRelay](MentionRelay.tla) models the relay in
[server/relay.ts](../../server/relay.ts). It starts with imported chat
commands and ends when the relay queues a reply, fails, or stops.

MentionRelay covers the `@blibs` introduction, the project list, project
matches, unresolved tasks, `/select`, and `/new-project`. It also covers
`/new`, `/sessions`, and `/resume`. It includes baseline import,
disabled harness checks, project removal, pending choice invalidation,
and restart.

TLC checks that a pending choice belongs to its chat, expired tasks stay
expired, a task starts at most once, and only one run is active per project.
Only a valid `/new` or `/resume` can queue harness work. A project match or
`/select` returns the sessions for that project. A new session gets a fresh ID,
a resume resolves to an ID from the chat and project, and the relay records a
notice for the selected ID. An unavailable session rejects the task. The relay
adds a mapping only when OpenCode reports the new ID. A failure before that
point leaves the name available. Saved IDs survive restart.

For the enabled harness, dispatch uses the request model, the saved model,
or the harness default in that order. A settings change applies to later
dispatches. It cannot change the model of a run that already started. The
saved model survives restart. When the harness catalog shows that the
requested model is unavailable, the relay returns model choices before
it resolves a session. The model classifies catalog results as inputs
and leaves the ranking of model IDs to the relay tests.

The command checks three configurations:

- `MentionRelay.cfg` uses two chats, two projects, and two requests. It checks
  session isolation across chat and project boundaries and overlapping work.
- `MentionRelay.sessions.cfg` uses one chat, one project, and three requests.
  It can start two named sessions and then resume either session or reject a
  selection. It starts empty or with an existing default mapping.
- `MentionRelay.models.cfg` uses two requests in one chat and project. It
  checks run overrides, unavailable models, saved defaults, and dispatch
  after settings changes or restart.

The model treats parsing, project matching, and name validation as classified
inputs. It represents a session name or a legacy ID selector by the symbolic
ID it addresses. The relay tests check case-insensitive name lookup within
the chat and project, legacy ID compatibility, and the text shown to Muse.
For a new session, the model uses the creating request slot as the symbolic
ID OpenCode returns. The model treats saving that ID and queuing the notice
as one step. It allows any eligible queued job to dispatch. It assumes
successful storage and notice writes. It omits FIFO order, cache
eviction, capacity limits, storage failures, and provider delivery after a
message enters the outbox.

To add a model, put its `.tla` module and `.cfg` file here. Name the module
after the file and list the properties to check in the configuration. To
run it, change to `tests/specs` and use its filenames in this command:

```sh
java -jar .tlc/tla2tools.jar -metadir .tlc/states -config MyModel.cfg MyModel.tla
```

The model check is opt-in. The app and the regular test suite need no Java.

## Statechart

Open the [MentionRelay statechart](MentionRelay.chart.md) for the request
lifecycle. The chart uses one chat, one project, and one request. It starts with one
saved session and shows only the enabled harness. These limits keep the
model choices and session paths within the statechart tool's 500-state limit.

To regenerate the chart, use the user-level `statechart` skill. Run these
commands from the repository root.
Copy the generated Mermaid into the request lifecycle block in
`MentionRelay.chart.md`.

```sh
chart_dir=$(mktemp -d)
TLA2TOOLS="$PWD/tests/specs/.tlc/tla2tools.jar" JAVA="$(command -v java)" \
  "$HOME/.agents/skills/statechart/scripts/statechart" tests/specs/MentionRelay.tla \
  --config tests/specs/MentionRelay.chart.cfg \
  --view tests/specs/MentionRelay.view.mjs --out "$chart_dir/result"
cat "$chart_dir/result/chart.mmd"
```
