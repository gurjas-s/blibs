---
name: validate
description: Select and run the checks for a blibs change before review. Record the results and capture relevant PR screenshots.
---

# Validate a change

## Cover new behavior

Exercise distinct outcomes through the normal entry point. Use unit or
integration tests when they cover the behavior. Use desktop E2E when it
depends on Electron or the provider. For a manual check, record the action,
expected result, and reason it needs a person.

## Before review

| Change | Checks |
| --- | --- |
| Documentation or skills only | Check changed links, paths, and commands. Exercise any new or changed workflow commands. |
| Code | Run `npm run build`, `npm run lint`, and `npm run test:built`. |
| App startup, first run, or backend health route | Run the relevant mock smoke tests with `npm run e2e:built`. |
| Panel behavior | Run the relevant desktop checks for the changed behavior. Use mocks for states that are hard to reproduce with the provider. |
| Build outputs or build scripts | Also run `npm run verify:clean-build`. |
| Provider sign-in persistence, sync, delivery, or relay | Run the [authenticated provider workflow](../verification/SKILL.md#authenticated-provider-checks). |
| User-facing behavior | Use the [verification skill](../verification/SKILL.md) for the changed behavior. |

Reuse one fresh build for the `:built` commands. Lint must pass without
warnings. On headless Linux, run
`xvfb-run -a npm run e2e:built` after the build.

Fix failures introduced by the change. If a failure appears unrelated,
check the base revision when practical. Report the failing check, the
evidence about its cause, and any checks that could not run.

## Evidence

Report commands, results, and skipped steps in the pull request or task
thread. For a visible change, capture the affected screen or state. Prefer
screenshots from the authenticated app when the ticket depends on real
provider behavior. Screenshots of the provider UI are allowed. Keep
credentials, cookies, and private chat contents out of the capture. Use mock
data when it fits the ticket. For an onboarding or sign-in change, capture the relevant
onboarding, sign-in, and post-sign-in states. Use both themes when the
change affects appearance in both. The smoke spec saves screenshots under
`tests/e2e/artifacts/`.

When a pull request exists, attach the relevant screenshots to its body with
`gh pr edit <number> --attach <path>`. Otherwise, give the artifact paths
in the task thread.
