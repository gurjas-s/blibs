# Working on blibs

blibs is an Electron app that syncs chats from persistent provider sessions
and queues replies. Read [README.md](README.md) before making changes.

## Architecture

- `src/main/` owns windows, vendor sessions, IPC, and sync timers. `login.ts`
  owns sign-in windows and events.
- `src/preload/` collects and sends messages inside vendor views.
  `panel.ts` exposes the narrow desktop bridge.
- `src/renderer/` is the React panel. Route data and storage through
  `client.ts` and desktop actions through `desktop.ts`. Use typed props and
  callbacks. Keep Node, Electron, backend imports, and direct data access
  out of components. Show sign-in events inline and preserve Back, Cancel,
  and Escape.
- `server/` owns local HTTP routes, imports, and the outbox. It uses ES
  modules. The main process and preloads build to CommonJS.
- `tests/` contains unit, HTTP, and desktop tests. `tests/e2e/` contains the
  desktop harness and specs.

## Development rules

- Use Node.js 24 and the committed lockfile. Keep changes typed and focused
  on one issue per branch and commit. Explain the behavior and validation in
  the PR.
- Add or extend automated tests for each new feature. Cover the main flow
  and branches with distinct outcomes. Test changes to delivery, storage,
  and session state.
- Keep vendor access in the main process and preload. Validate IPC senders
  and payloads. Keep session credentials in Electron's persistent partitions
  and expose only scoped desktop actions and navigation.
- Keep credentials, cookies, session data, and real chats out of the
  repository, logs, and artifacts. Keep screenshots and one-time evidence
  out of Git. Leave generated `build/`, `dist/`, and `node_modules/` files to
  their scripts.
- Keep the `blibs` name in the menu, About panel, and window title. Use the
  icon from `assets/` for the Dock and window. After editing
  `assets/icon.svg`, run `npm run icons` on macOS and commit its output.
- Keep `--force` in the TypeScript build so it regenerates missing output
  with the incremental cache present.

## Skills

| Task | Skill |
| --- | --- |
| Set up a checkout or fix startup | [onboarding](.agents/skills/onboarding/SKILL.md) |
| Change renderer UI | [design](.agents/skills/design/SKILL.md) |
| Check a change before review or after updating a PR | [validate](.agents/skills/validate/SKILL.md) |
| Verify changed user-facing behavior | [verification](.agents/skills/verification/SKILL.md) |
| Update a feature's verification steps or test references | [write-verification-guide](.agents/skills/write-verification-guide/SKILL.md) |

Use the existing signed-in blibs profile for provider checks and screenshots
without asking for confirmation. Send synthetic verification messages in
the current provider conversation when needed.
Follow the [authenticated workflow](.agents/skills/verification/SKILL.md#authenticated-provider-checks)
for automation, test data, and account boundaries.

## Review

Check behavior through the normal entry point and preserve caller contracts.
For delivery and session changes, check failures, retries, and restarts for
duplicate sends or inconsistent state. For storage changes, check existing
data and recovery from partial failure. Confirm that applicable checks and
evidence are in the PR. Require both Linux and Windows `Build, lint, and test`
checks on the default branch.

Write project text in English. Use ASD-STE100 Simplified Technical English
in PRs, reviews, commits, comments, and docs. Use short, active sentences.
Use comments to explain behavior the code does not make clear.
