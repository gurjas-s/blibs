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

MentionRelay covers the `@blibs` introduction, the bare `@opencode` project
list, direct and inferred project matches, unresolved tasks, `/select`,
and `/new-project`. It includes baseline import, disabled harness checks,
project removal, pending choice invalidation, and restart.

TLC checks that a pending choice belongs to its chat, expired tasks stay
expired, a task starts at most once, and only one run is active per project.
The model covers default session reuse within each chat and project,
with a different default session for each pair. The relay integration
tests cover named session creation, selection, and restart.

The configuration uses two chats, two project paths, and two request slots.
It treats parsing, filtering, and project matching as inputs with classified
outcomes. A saved task uses its original request slot as the selection ID.
Project names and tokens are unique in the model. The model allows any
eligible queued job to dispatch, without modeling FIFO order or queue
limits. It assumes retained message history and session mappings survive
restart. It does not model cache eviction, storage failure, or provider
delivery after the reply enters the outbox.

To add a model, put its `.tla` module and `.cfg` file here. Name the module
after the file and list the properties to check in the configuration. To
run it, change to `tests/specs` and use its filenames in this command:

```sh
java -jar .tlc/tla2tools.jar -metadir .tlc/states -config MyModel.cfg MyModel.tla
```

The model check is opt-in. The app and the regular test suite need no Java.

## Statechart

Open the [MentionRelay statechart](MentionRelay.chart.md) for the request
lifecycle. The chart uses one request slot to fit the statechart tool's
500-state limit. The full check uses two slots to explore overlapping work.

To regenerate the chart, use the user-level `statechart` skill. Run these
commands from the repository root.
Copy the generated Mermaid into the fenced block in `MentionRelay.chart.md`.

```sh
chart_dir=$(mktemp -d)
TLA2TOOLS="$PWD/tests/specs/.tlc/tla2tools.jar" JAVA="$(command -v java)" \
  "$HOME/.agents/skills/statechart/scripts/statechart" tests/specs/MentionRelay.tla \
  --config tests/specs/MentionRelay.chart.cfg \
  --view tests/specs/MentionRelay.view.mjs --out "$chart_dir/result"
cat "$chart_dir/result/chart.mmd"
```
