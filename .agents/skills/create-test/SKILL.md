---
name: create-test
description: Add a verification document for a blibs user-facing feature. Use after you add or change a feature, or when a feature has no end-to-end document.
---

# Add a verification document

One user-facing feature has one document in
`.agents/skills/verification/e2e-testing/`. The document lets an agent verify
the feature with mocked data and no live vendor login.

## 1. Choose the file name

Use a lowercase kebab-case name for the feature. End the name with `.md`.
Examples: `onboarding.md`, `vendor-login.md`, `conversation-search.md`.

- Do not put a date or a version in the name.
- Do not create a second document for a sub-feature. Add a section to the
  existing document.
- Update the feature map in `e2e-testing/README.md` in the same change.

## 2. Use the required sections

Use these sections in this order:

1. `## Scope and non-goals`
2. `## Preconditions and setup`
3. `## Test steps`
4. `## Failure signals and artifacts`
5. `## Cleanup`
6. `## Automated tests that cover it`

Do not add a section that repeats the same information. Put a manual boundary
inside the step that needs it.

## 3. Write the steps

- Number every step.
- Put an exact command or UI action in the step.
- Put the expected result in the step.
- Use `BLIBS_MOCK_LOGIN=1` and a temporary profile. Do not use a live vendor
  login, a real chat, a cookie, or a credential.
- If a step needs a live vendor session, write `Manual boundary:` and explain
  why. Stop and ask the user before you do it.
- Use a temporary store and a free port. Do not write to `server/imports.json`,
  `server/outbox.json`, or a real history directory.
- Link to the related document when a step tests another feature.

## 4. Write the failure and cleanup sections

- List the observable failure signals: a status text, a console error, a
  missing screenshot, or a failed test name.
- List the artifact paths. Put screenshots in the pull request body. Do not
  commit an evidence report.
- Give the exact cleanup commands. Remove temporary directories and stop the
  app.

## 5. List the automated tests

Name the test file and the test title. Include the command that runs it.
If no automated test covers the feature, write `No automated test covers this
feature.` and state the gap in the pull request.

## 6. Use the writing rules

- Write in English with ASD-STE100 Simplified Technical English.
- Use short sentences and active voice.
- Put one idea in each sentence.
- Define a technical term at its first use.
- Use the imperative for a step.
- Do not use an idiom or a metaphor.
- Keep the document task-oriented. Remove history and opinion.

## 7. Read the example

Read [onboarding.md](../verification/e2e-testing/onboarding.md) as the example.
It has the required sections, the shared mock setup, and the explicit boundary
for a live session.

## 8. Review checklist

- [ ] The file name is kebab-case and lives in `e2e-testing/`.
- [ ] The six sections are present and in order.
- [ ] Every step is numbered and has an exact command or UI action.
- [ ] Every step has an expected result.
- [ ] The steps need no live vendor login.
- [ ] A live-session step has a `Manual boundary:` note.
- [ ] The feature map in `README.md` points to the document.
- [ ] The automated test list names the file, the test, and the command.
- [ ] The cleanup removes temporary data and stops the app.
- [ ] No evidence report, credential, cookie, or real chat is committed.
- [ ] The text is English and follows ASD-STE100.
