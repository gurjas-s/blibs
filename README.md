# blibs — one desktop app for your personal agents

[![CI](https://github.com/gurjas-s/blibs/actions/workflows/ci.yml/badge.svg)](https://github.com/gurjas-s/blibs/actions/workflows/ci.yml)

blibs is a desktop control panel for **personal agents** — the always-on,
action-taking kind (Meta **Muse**, OpenAI **Dots**, xAI **Grok**), not plain chatbots.

blibs connects each assistant to the local coding harnesses on your computer
(**Claude Code**, **Codex**, **OpenCode**). You select the harnesses for each
assistant one time. You also select the shared folder that the harnesses may
read and write. Chat with all three assistants on their websites in one window.

blibs keeps your vendor sessions active so it can sync chats and send replies.

## Contributor setup

Use the [onboarding skill](.agents/skills/onboarding/SKILL.md) to set up a
checkout and start blibs with a temporary profile and mock sign-in.

See the [verification loop diagram](docs/verification-loop.md).

## First run for personal use

Prerequisites: Node.js 24.x (`node -v` must print `v24.…`). Electron 34's
installer does not work on newer Node.js releases, so switch to Node 24 before
installing (`fnm use 24` or `nvm use 24`). No browser setup needed — sessions
live in the app.

```bash
npm ci             # install the exact dependency versions in package-lock.json
npm run build      # typecheck + compile + bundle the panel
npm start          # launch the desktop app
```

`npm ci` fails with an actionable message if Electron's binary is missing,
rather than letting `npm start` fail later with `Electron failed to install
correctly`. After changing `package-lock.json`, use `npm install` locally and
commit the updated lockfile; everyone else and CI use `npm ci`.

The first start opens the **Connections** screen. It shows one row for each
local harness and one column for each assistant. Muse supports OpenCode and
Codex. Turn each on or off independently. Set the shared folder and select
**Start chatting**.

Install and sign in to the Codex CLI before you use Codex. Start blibs from
a shell that can find the `codex` executable on `PATH`.

Select **Connect another assistant** on the Connections screen to sign in to
Muse, Dots, or Grok (once each). The **Agents** item in the sidebar opens the
same sign-in screen. Sign-in opens the provider website in the center pane.
If the vendor asks for a code or a CAPTCHA, complete that step on the website.
Select **Check again** to check the connection. Select **Back to Agents** or
press **Escape** to return to the sign-in screen.

Select a connected assistant in the sidebar to open its website in the center
pane. The website shares its session with the background sync view. Send
messages and copy or paste text using the website. Select **Connections** in
the sidebar to change the harnesses or the folder.

Chats flow in automatically. The app pushes seconds after chat content
changes and checks once a minute as a backup. The panel pulls every 15 seconds
by default. Change the auto-sync settings in **Settings**.

**Ask blibs about itself:** tag `@blibs` in a chat. blibs sends one generated
reply into the conversation and shows it in the panel. The reply explains what
blibs does, lists the available and enabled harnesses, and explains how to send
a task with a harness tag. It suggests the first enabled harness. When no
harness is enabled, it says to turn one on in Connections.

**Choose a project and session:** the examples use `@opencode`. Use
`@codex` for the same commands with Codex. Send `@opencode` by itself to list
project IDs. Send `@opencode /sessions $alpha` to list the session names for the
`alpha` project in this chat. Only `/new` and `/resume` start a harness task.

- Start with fresh context using `@opencode /new $alpha first <task>`. A
  session name is one word of up to 40 characters. Use letters, numbers,
  underscores, or hyphens, and start with a letter or number.
- Continue an existing session using `@opencode /resume $alpha first <task>`.
  Session names ignore case. For a new session, blibs saves the ID the harness
  returns and announces the name. For a resume, blibs announces the saved
  name before it starts the task. Legacy sessions remain available as
  `Default` in OpenCode. Named sessions persist across restart. Each harness
  has its own session names for each chat and project.

**Choose a harness model:** Open **Settings → Harness models**. Leave the
model ID blank to use the harness default. Enter a model ID and save to set a
blibs default for that harness. For OpenCode, enter `provider/model`. For
Codex, enter a Codex model ID.

To use a different model for one task, ask Muse to use that model. Muse can
send `@opencode /new $alpha first --model provider/model <task>` or
`@opencode /resume $alpha first --model provider/model <task>`. The option
applies to that run. Later runs use the configured default when Muse omits it.
If the harness lists models for the project and the requested ID is missing,
blibs replies with up to five close matches. Muse can send the same command
with one exact ID from the list and the full task.

A project mention such as `@opencode $alpha <task>` lists the sessions. If
the project is unclear, blibs lists project IDs and gives Muse a request ID.
Muse can reply with `@opencode /select <request-id> $<project>` to see the
sessions, then send the full task with `/new` or `/resume`. A request ID can
select a project once. Pending choices expire when blibs restarts, the chat
is cleared, or the projects folder changes.

To create a project, ask Muse for a new project. Muse sends
`@opencode /new-project <name>`. blibs creates one empty folder in the
configured projects directory and returns its project ID. Muse can use that
ID with `/new` to start a session. You can
also select **New project** in the **Connections** project picker. Use a name
that starts with a letter or number and contains only letters, numbers,
spaces, dots, underscores, and hyphens.

**Harness replies:** a reply from a local coding harness starts with
`Sent from user's harness (<harness name>).` The header shows where the message
came from. blibs sends the final assistant response. Harness tool output
and intermediate responses stay out of the chat. blibs sends the full final
response, including long replies.

To change a default through the local API, send `harnessId: "opencode"` or
`harnessId: "codex"` and a `model` ID to `POST /api/relay/projects`. Send
`model: null` to use the selected harness default. Set the projects directory with
`discoveryRoot`. The relay uses only its immediate subfolders. A run that
fails posts a short failure note into the chat. Set `BLIBS_CODEX_COMMAND` to use a
custom command prefix that ends in `exec`. Codex uses the selected project
as its working directory and runs with the Codex workspace-write sandbox.

## Relay logs

Start blibs from a terminal with `npm start` to see the relay logs. Search for
`blibs-relay` to see whether blibs skipped a request, matched a project,
started a harness, or queued a reply. Search for `blibs-outbox` to see if the
app acknowledged a send. The logs omit chat text, prompts, and harness output.

## Scripts

| Command | What |
|---|---|
| `npm run build` | Build the app |
| `npm run check` | Build, lint, and run the tests against the build |
| `npm start` | Launch the app (needs a prior `build`) |
| `npm test` | Rebuilds, runs unit and HTTP route tests, then runs the desktop harness with temporary stores and ports |
| `npm run e2e` | Build the app and run end-to-end checks; needs a display |
| `npm run test:built` | Run unit, HTTP, and headless harness checks against the current build |
| `npm run e2e:built` | Run desktop smoke checks against the current build |
| `npm run mock:desktop` | Open the built app with a temporary profile and mock sign-in |
| `npm run e2e:live` | Check the relay with a signed-in Muse profile and `BLIBS_LIVE_LOGIN=1` |
| `npm run test:desktop` | Test search and citations; needs a display, but no model downloads |
| `npm run smoke` | Check that the app starts; needs a display |
| `npm run lint` | Check the code for lint errors |
| `npm run test:specs` | Check the TLA+ model with TLC. See [setup](tests/specs/README.md) |
| `npm run icons` | Regenerate the app PNG sizes, the macOS `.icns`, and the panel favicon from `assets/icon.svg`; needs macOS |
| `npm run clean` | Wipe `build/` + `dist/` |
| `npm run verify:clean-build` | Delete generated output, rebuild with the existing incremental cache, and check that all required output was regenerated |

CI runs `npm run check` and `npm run verify:clean-build` on Linux and Windows
for every push and pull request.

## App icon and packaging

`assets/icon.svg` is the icon source. It is flat and uses one accent color. The
committed files below are generated from it:

- `assets/icons/16.png` to `assets/icons/1024.png`
- `assets/blibs.icns` for macOS
- `public/favicon.svg` for the panel tab

Run `npm run icons` on macOS after you change the source. The command uses
`sips` and `iconutil`, so it needs no extra package. Linux and Windows use the
committed files and do not run the command.

At runtime `src/main/index.ts` sets the app name to `blibs`, builds the
application menu and the About item with that name, sets the Dock icon from
`assets/icons/1024.png`, and sets the window icon from `assets/icons/512.png`
where the platform shows one.

The repository has no packager, so the app runs from the checkout. To build an
installer, add a packager and then:

- Set the product name and the executable name to `blibs`.
- Copy `assets/` into the app resources. The main process reads
  `process.resourcesPath/assets` when `app.isPackaged` is true.
- Set `assets/blibs.icns` as `CFBundleIconFile` on macOS.
- Set the app id to `com.blibs.app`, to match `app.setAppUserModelId` on
  Windows.

## End-to-end tests

`npm run e2e` builds the app and runs end-to-end checks. It uses temporary data
and mock chats, so it needs no vendor account.

The check needs a display. On Linux without `DISPLAY` or `WAYLAND_DISPLAY`, the
check skips with a message; use `xvfb-run -a npm run e2e` on a headless machine.
`npm test` does not run the e2e check.

### Authenticated provider checks

For each user-facing change, follow the
[authenticated provider workflow](.agents/skills/verification/SKILL.md#authenticated-provider-checks)
to test the changed path in the built app with the existing signed-in
profile. The automated scripts below can send commands to a real account.
Check their side effects before running them.

### Live Muse relay check

Run `BLIBS_LIVE_LOGIN=1 npm run e2e:live` with a signed-in Muse profile
and both harnesses configured. The checks use the current Muse conversation.
They verify the harness reply and exact bytes in `alpha/hello.txt` for a
new and an existing project. The named-session checks refresh the `@blibs` introduction and verify two
new sessions and a follow-up for each harness. The checks remove their
temporary projects when done.

Set `BLIBS_LIVE_PROFILE` to use a different signed-in profile. Set
`BLIBS_LIVE_MODEL` to override the model. This check runs outside CI.

Do not commit a profile, a screenshot of a signed-in session, or a credential.
See the [project selection verification steps](.agents/skills/verification/e2e-testing/project-selection.md)
for setup and expected results.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '…/build/main/index.js'` on `npm start` | You skipped the build — run `npm run build` first (`build/` is generated) |
| `Electron failed to install correctly` | Use Node.js 24.x. If npm blocked the install script, run `npm install-scripts approve electron`, then `npm ci` again |
| Weird behavior right after `npm start` | Make sure `ELECTRON_RUN_AS_NODE` is **not** exported in your shell (`unset` it and remove it from `~/.zshrc` — it makes Electron act as plain Node) |
| Blibs: `Backend unreachable` pill | Backend didn't boot with the app — restart; check the terminal for `[blibs] proxy exited` |
| `EADDRINUSE` on `:5174`/`:8787` in `npm test` | A previous app instance is still running — quit it first |
| Send stuck on `Sending…` | Session not signed in or page still loading — use Agents, then Retry |
| Harness run shows `harness exited with code 1` | Check the harness sign-in, model, and account limits. Change its default in **Settings → Harness models**. |
| Login lost after restart | Partitions persist per OS user; check you didn't clear app data |
