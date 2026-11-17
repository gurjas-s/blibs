---
name: verification
description: Verify a blibs feature end to end with a repeatable document. Use when a change touches a user-facing feature, when a reviewer asks for a manual check, or when you add a feature document.
---

# Verify a blibs feature

Use this skill after the automated checks pass. It gives one document for each
user-facing feature. Each document has exact steps, expected results, failure
signals, cleanup, and the automated tests that cover the feature.

## When to use this skill

- A pull request changes a user-facing feature.
- A reviewer asks for end-to-end evidence.
- A new feature needs a verification document.
- A release needs a full pass over all documents.

## Start here

1. Read [the e2e testing guide](e2e-testing/README.md).
2. Choose the document for the changed feature from the feature map.
3. Run the automated tests in the document.
4. Run the numbered steps. Use the mock login and a temporary store.
5. Write the result in the pull request body or the worker report.

Do not commit an evidence report or a reproduction note. Keep a screenshot for
the pull request body in the pull request.

## Add a document

Use the [create-test skill](../create-test/SKILL.md) to add or change a feature
document. Update the feature map in the e2e testing guide in the same change.

## Boundaries

- Do not use a live vendor login, a real chat, a cookie, or a credential.
- Use `BLIBS_MOCK_LOGIN=1` and a temporary profile.
- Mark a step that needs a live vendor session as a manual boundary. Stop and
  ask the user before you do it.
- Keep repeatable steps in this skill. Put the result of one run in the pull
  request body or the worker report.
