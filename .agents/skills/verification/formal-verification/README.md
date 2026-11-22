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
fails, or stops. The model checks session ownership, rejection of unknown
IDs, choice prompts for ambiguous requests, notices for follow-ups, and
persistence across restart.

1. Check whether the implementation still matches the model. If intended
   behavior changes a modeled transition or invariant, update the spec and
   regenerate the statechart as described in the spec guide.
2. Run `npm run test:specs` from the repository root. TLC checks the
   transitions in both configurations.
3. Run or extend the relevant [relay implementation tests](../../../../tests/relay.test.ts).
   Exercise the affected outcome through the normal entry point. For example,
   use a repeated project selection to check that a task starts at most once,
   or resume named sessions after restart to check that their histories stay
   separate.
4. Record the TLC result, the affected invariant, and the implementation
   test that exercises it. Include these results in the review brief when
   review applies.

The Linux and Windows CI jobs use the shared implementation checks. Run
TLC locally.
