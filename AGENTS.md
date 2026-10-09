# Working on blibs

blibs is an Electron app that collects chats from persistent vendor sessions
and queues replies for those sessions. Read `README.md` before making changes.

## Architecture

- `src/main/`: Electron windows, vendor views, IPC, local servers, and sync timers.
- `src/preload/`: DOM collection and message delivery inside vendor sessions.
- `src/renderer/`: React panel. This code has browser APIs, but no Node access.
- `server/`: Local HTTP backend, import store, and send outbox.
- `tests/`: Unit tests and HTTP route tests using `node:test`.
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
npm run verify:clean-build
```

`npm test` builds the app, runs unit and HTTP tests, and runs the desktop harness
without a display. Tests must use temporary stores and their own ports.
`verify:clean-build` deletes generated output while keeping TypeScript's
incremental cache, rebuilds, and checks that all required output exists.
Keep `--force` in the TypeScript build command.

## Contributions

- Use one branch and focused commit per issue. Explain the behavior and validation in the PR.
- **Write all PR descriptions, titles, comments, and review feedback in ast100-ste language.**
- Keep new logic typed and test changes that affect delivery, storage, or session state.
- Use plain, task-oriented language. Follow the Google developer documentation style guide when project usage does not answer a writing question.
- Keep the flat slate theme with one accent color.
- Do not edit or commit `build/`, `dist/`, `node_modules/`, real chat data, or credentials.
- Keep vendor session access in the main process and preload. Validate IPC senders and do not expose arbitrary IPC or navigation to the renderer.
- Keep session credentials in Electron's persistent partitions. Ask the user to sign in when a vendor requires credentials or a CAPTCHA.

## CI

The `CI` workflow runs the checks on Linux and Windows for pushes and PRs.
Repository admins must require both `Build, lint, and test` checks in the
default branch's protection rules to prevent merging a failing PR.
