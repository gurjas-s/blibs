---
name: write-verification-guide
description: Update a blibs feature guide when its verification steps, expected results, or coverage change.
---

# Write a verification guide

Update the existing guide in the [feature map](../verification/e2e-testing/README.md).
Add a guide and map entry when no existing guide fits.

Give the feature-specific setup, actions, expected results, and test
references. Keep commands or fixtures needed to reproduce the behavior.
Link to shared setup and label steps that need the
[authenticated provider workflow](../verification/SKILL.md#authenticated-provider-checks).
Include cleanup or artifact details only when they differ from the shared
workflow. See the [onboarding guide](../verification/e2e-testing/onboarding.md).
