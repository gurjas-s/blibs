---
name: validate
description: Run the blibs verification loop from local checks through review and PR CI.
---

# Validate a change

## Cover new behavior

Exercise distinct outcomes through the normal entry point. Use unit or
integration tests when they cover the behavior. Use desktop E2E when it
depends on Electron or the provider. For a manual check, record the action,
expected result, and reason it needs a person.

## 1. Run local checks

| Change | Checks |
| --- | --- |
| Documentation or skills only | Check changed links, paths, and commands. Exercise any new or changed workflow commands. |
| Code | Run `npm run check` on Node.js 24. |
| App startup, first run, or backend health route | Run the relevant mock smoke tests with `npm run e2e:built`. |
| Panel behavior | Run the relevant desktop checks for the changed behavior. Use mocks for states that are hard to reproduce with the provider. |
| Build outputs, build scripts, or incremental cache | Also run `npm run verify:clean-build`. |
| User-facing behavior, including UI-only changes | Use the [verification skill](../verification/SKILL.md) for the feature guide and live signed-in check. |
| A TLA+ model or behavior it covers | Use the [formal verification guide](../verification/formal-verification/README.md). Include indirect effects through shared code. |

Reuse one fresh build for the `:built` commands. Lint must pass without
warnings. On headless Linux, run
`xvfb-run -a npm run e2e:built` after the build.

Fix failures introduced by the change. If a failure appears unrelated,
check the base revision when practical. Report the failing check, the
evidence about its cause, and any checks that could not run.

## 2. Update guides and record evidence

Use [write-verification-guide](../write-verification-guide/SKILL.md) when the
change affects setup, steps, expected results, coverage, or model scope or
assumptions. Check guide links and test references before review.

Report commands, results, and skipped steps in the pull request or task
thread. For a visible change, capture the affected screen or state. Use screenshots
from the live signed-in check when they show the changed behavior. Screenshots of the provider UI are allowed. Keep
credentials, cookies, and private chat contents out of the capture. Use mock
data when it fits the ticket. For an onboarding or sign-in change, capture the relevant
onboarding, sign-in, and post-sign-in states. Use both themes when the
change affects appearance in both. The smoke spec saves screenshots under
`tests/e2e/artifacts/`.

Attach relevant screenshots to the PR when the host supports attachments.
Otherwise, give the artifact paths in the task thread.

## 3. Get one fresh review when required

Run this step only if you are the lead implementing agent and use a Luna
model or run through OpenCode. If you are an implementing subagent, hand
your changes and check results back to the lead agent for review. The lead
applies this rule to the complete change. Other lead agents continue to PR
CI or handoff.

From the repository root, launch a new Codex CLI session with a read-only
shell sandbox. Use a temporary brief outside the checkout. Remove the brief
after the review. If the CLI or read-only sandbox is unavailable, report the
blocker.

```sh
codex exec --sandbox read-only --model gpt-6.2-sol \
  -c 'model_reasoning_effort="low"' -c 'approval_policy="never"' - < "$review_brief"
```

Include these sections in the brief:

- **User prompts.** Quote the actual user prompts that state or change
  requirements, word for word and in chronological order. Include clarifying
  follow-ups and decisions that supersede earlier requirements. Keep secrets
  and private chat data out of the brief and identify any redactions.
- **Change and evidence.** Give the base revision and review target. Identify
  relevant staged, unstaged, and untracked files for a working-tree review.
  List checks and results, including applicable live or formal checks and
  the reason for each skip.
- **Reviewer task.** Derive a checklist from the quoted prompts. Verify each
  requirement against the diff and normal entry point. Mark each as met,
  partial, missing, or unable to verify, with supporting evidence. Flag scope
  changes, correctness issues, regressions, and gaps in test coverage. For
  each finding, include a file and line, triggering scenario, and impact.
  State when there are no actionable findings. Inspect the change and return
  the assessment to the implementing agent. Keep the checkout, Git state,
  and external services read-only. End the review after reporting findings.

Assess each finding and fix confirmed issues. Record why any finding remains
open. Run `npm run check` after code fixes and repeat affected targeted checks.
Use one review pass. The implementing agent owns follow-up fixes.

## 4. Follow PR CI through completion

For a task with a PR, check both required **Build, lint, and test** jobs on
the latest pushed revision. In T3, if either job is pending, watch the PR
through checks and yield. The watch stays active across pushes. Use the
available CI monitoring mechanism outside T3.

When a job fails, confirm the failure belongs to the current revision and
read the job logs. Fix the cause, rerun the applicable local checks, and
push to the same PR branch. Rerun the failed check for a transient runner
or service failure. Continue until both Linux and Windows pass on the
latest revision or a blocker requires user action. Stop watching at handoff.

Without a PR, finish after local checks and the applicable review. Report
the verification and review results, skips, and any remaining blockers.
