---
name: write-verification-guide
description: Maintain blibs E2E and formal verification guides when behavior or checks change.
---

# Write a verification guide

## E2E guides

Update the existing guide in the [feature map](../verification/e2e-testing/README.md).
Add a guide and map entry when no existing guide fits.

Give the feature-specific setup, actions, expected results, and test
references. Keep commands or fixtures needed to reproduce the behavior.
Link to shared setup and label steps that need the
[authenticated provider workflow](../verification/SKILL.md#authenticated-provider-checks).
Include cleanup or artifact details only when they differ from the shared
workflow. See the [onboarding guide](../verification/e2e-testing/onboarding.md).

## Formal verification guides

Update the [formal verification guide](../verification/formal-verification/README.md)
when a change affects the model scope, assumptions, invariants, or related
implementation tests. Add an entry when you add a model.

Describe when the model applies, including changes in shared code that can
affect it. List the invariants and link the implementation tests that
exercise the same behavior. Link to the [spec guide](../../../tests/specs/README.md)
for TLC setup and commands.

If intended behavior changes a modeled transition or invariant, update
the model and its configuration as needed. Use the user-level statechart
skill to regenerate the diagram.
