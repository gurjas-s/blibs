# Working on blibs

blibs is an Electron app that collects chats from persistent vendor sessions
and queues replies for those sessions. Read `README.md` before making changes.

## Architecture

- `src/main/`: Electron windows, vendor views, IPC, local servers, and sync timers.
- `src/preload/`: DOM collection and message delivery inside vendor sessions.
- `src/renderer/`: React panel. This code has browser APIs, but no Node access.
- `server/`: Local HTTP backend, import store, and send outbox.
- `tests/`: Unit tests, HTTP route tests, and the CDP end-to-end harness and
  specs in `tests/e2e/`.
- `scripts/`: Build helpers and checks.

The package uses ES modules. The main process and preloads compile to CommonJS;
the build writes their `package.json` markers. The backend remains an ES module.

## Commands

Use Node.js 24 and the committed lockfile.

```sh
npm ci
npm run build
npm run lint
npm test
npm run e2e
npm run verify:clean-build
```

`npm run lint` runs the ESLint flat config in `eslint.config.js` and fails on
warnings. `npm test` builds the app, runs unit and HTTP tests, and runs the
desktop harness without a display. Tests must use temporary stores and their own
ports. `npm run e2e` builds the app, starts the real Electron app with a remote
debugging port, and runs a smoke spec through `playwright-core` over CDP. It
writes a screenshot to `tests/e2e/artifacts/`, which Git ignores. The e2e check
needs a display; on Linux without `DISPLAY` or `WAYLAND_DISPLAY` it skips with a
message, and you can run it with `xvfb-run -a npm run e2e`.
`verify:clean-build` deletes generated output while keeping TypeScript's
incremental cache, rebuilds, and checks that all required output exists.
Keep `--force` in the TypeScript build command.

## Contributions

- Use one branch and a focused commit for each issue. Explain the behavior and the validation in the PR.
- Keep new logic typed. Test changes that affect delivery, storage, or session state.
- Use plain, task-oriented language. Follow the Google developer documentation style guide when project usage does not answer a writing question.
- Use the repository skills in `.agents/skills/` for onboarding and validation.
- Keep the flat slate theme with one accent color.
- Do not edit or commit `build/`, `dist/`, `node_modules/`, real chat data, or credentials.
- Keep vendor session access in the main process and preload. Validate IPC senders and do not expose arbitrary IPC or navigation to the renderer.
- Keep session credentials in Electron's persistent partitions. Ask the user to sign in when a vendor requires credentials or a CAPTCHA.

## Writing

Write all project text in English. Use ASD-STE100 Simplified Technical English
for PR titles, PR descriptions, review comments, and user-facing docs.

Use short sentences. Use active voice. Put one idea in each sentence. Define
each technical term once, at its first use. Do not use an idiom or a metaphor
in place of a clear instruction.

This rule applies to:

- PR titles and PR descriptions.
- Review comments and review feedback.
- Commit messages and code comments.
- User-facing documentation, including `README.md` and `docs/`.

## Validation

Run these commands before you open a PR and after you change the PR:

```sh
npm run build
npm run lint
npm test
```

- `npm run lint` must pass with no warnings.
- `npm test` must pass. A failing test is acceptable only when the unit that
  the change modifies is the cause of the failure. In that case, write the
  failure, the cause, and the plan in the PR.
- Run `npm run e2e` when a change affects the panel, the app startup path, or
  the backend health route. The command needs a display.
- Do one manual test of the changed behavior. Write the steps and the result in
  the PR.
- If the change changes what a user sees, add a screenshot to the PR.

CI runs `npm run build`, `npm run lint`, `npm test`, and
`npm run verify:clean-build` on Linux and Windows. A local check does not
replace the CI result.

## Review checklist

A reviewer must confirm each item before approval:

- [ ] The PR title, PR description, review comments, commit messages, code comments, and user-facing docs are in English and follow ASD-STE100 Simplified Technical English.
- [ ] `npm run lint` and `npm test` pass.
- [ ] The PR describes one manual test and the result of that test.
- [ ] A visible change has a screenshot in the PR.
- [ ] The change does not add credentials, cookies, or session data.

Do not approve a PR that has non-English text in its comments or PR text.

## CI

The `CI` workflow runs the checks on Linux and Windows for pushes and PRs.
Repository admins must require both `Build, lint, and test` checks in the
default branch's protection rules to prevent merging a failing PR.
