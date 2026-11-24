# Formal verification for blibs

Run the applicable model check locally when a change affects a TLA+ model
or behavior it covers. Consider shared code that changes the model's inputs
or assumptions.

## MentionRelay

Use this model for changes to relay command intake, project selection,
pending choices, task dispatch, session reuse, or restart. For example,
a storage change can affect what the relay restores after a restart.
The [spec guide](../../../../tests/specs/README.md) lists the assumptions,
invariants, and TLC setup. The model ends when the relay queues a reply,
fails, or stops. The model checks that only explicit session commands can
queue work. It also checks ownership, rejection of unavailable sessions,
session notices, and persistence across restart. It checks that the relay
saves a new session only after the harness reports its ID. Apply the same checks to each
harness. The model represents one harness. The relay tests check that the
same chat and project can use separate Codex and OpenCode session names and
project selections. It also checks model
selection at dispatch, preservation of the chosen model after dispatch,
and changes to the saved default. The model uses symbolic model IDs.
The model checks that an unavailable model produces choices without a session
or run. The relay tests cover invalid syntax, the ranked choices, and a
retry with an exact ID.

1. Check whether the implementation still matches the model. If intended
   behavior changes a modeled transition or invariant, update the spec and
   regenerate the statechart as described in the spec guide.
2. Run `npm run test:specs` from the repository root. TLC checks the
   transitions in all three configurations.
3. Run or extend the relevant [relay implementation tests](../../../../tests/relay.test.ts).
   Exercise the affected outcome through the normal entry point. For example,
   use a repeated project selection to check that a task starts at most once,
   or resume sessions by name after restart to check that their histories stay
   separate.
4. Record the TLC result, the affected invariant, and the implementation
   test that exercises it. Include these results in the review brief when
   review applies.

The Linux and Windows CI jobs use the shared implementation checks. Run
TLC locally.
