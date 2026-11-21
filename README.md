# blibs — one desktop app for your personal agents

[![CI](https://github.com/gurjas-s/blibs/actions/workflows/ci.yml/badge.svg)](https://github.com/gurjas-s/blibs/actions/workflows/ci.yml)

blibs is a desktop control panel for **personal agents** — the always-on,
action-taking kind (Meta **Muse**, OpenAI **Dots**, xAI **Grok**), not plain chatbots.

blibs connects each assistant to the local coding harnesses on your computer
(**Claude Code**, **Codex**, **OpenCode**). You select the harnesses for each
assistant one time. You also select the shared folder that the harnesses may
read and write. Chat with all three assistants from one window, and reply from
blibs straight into the real assistant session.

blibs keeps your vendor sessions active so it can sync chats and send replies.

## Contributor setup

Use the [onboarding skill](.agents/skills/onboarding/SKILL.md) to set up a
checkout and start blibs with a temporary profile and mock sign-in.

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
local harness and one column for each assistant. Turn on a supported harness. This build supports OpenCode for Muse. The other
combinations show as unsupported. Set the shared folder. Select **Start chatting**.

Select **Connect another assistant** on the Connections screen to sign in to
Muse, Dots, or Grok (once each). The **Agents** item in the sidebar and the
**Agents** menu are other paths to the same screen. The sign-in window shares
cookies with the hidden sync view, so after sign-in you can close it — syncing
continues in the background. If the vendor asks for a mobile code or a CAPTCHA,
the agents screen shows that step. Select **Check again** after you complete it.
**Back to chats**, **Cancel**, and **Escape** always return to the panel.
The sign-in window is also a chat view while it is open. blibs reads the
messages there and types replies into the window that has focus. Close it to
continue in the hidden sync view.

An assistant with no signed-in session shows a setup card in its chat. The card
lists the steps, gives the connect link, and offers **Check connection** and
**Open assistant**. The composer stays disabled until the assistant is
connected. Select **Connections** in the sidebar to change the harnesses or the
folder later.

Chats flow in automatically: the app pushes seconds after chat content changes
(plus a 1-minute backup sweep), and the panel auto-pulls every 15s by default.
The Auto-sync toggle and interval are in Settings.

**Send from blibs:** type in the composer, hit Send. The message is queued on the
backend, the app types it into the matching session and sends it, and the badge
under your message flips `Sending…` → `Sent` (or `Not delivered` + Retry).
The agent's reply syncs back on its own.

**Ask blibs about itself:** tag `@blibs` in a chat. blibs sends one generated
reply into the conversation and shows it in the panel. The reply explains what
blibs does, lists the available and enabled harnesses, and explains how to send
a task with a harness tag. It suggests the first enabled harness. When no
harness is enabled, it says to turn one on in Connections.

**Choose a project:** tag a harness with a task but no project to get a list of
folders in the configured projects directory (`~/Projects` by default). The
reply asks the assistant to pick a project and send `$<project> <task>`. A
project name in the task also selects that project. blibs reuses one OpenCode
session for each project in each chat. A `$<project>` token that does not match
a folder gets a message with the placeholder command
`blibs new-project <name>`.

**Harness replies:** a reply from a local coding harness starts with
`Sent from user's harness (<harness name>).` The header shows where the message
came from.

The relay uses OpenCode. It uses the personal OpenCode Go provider with the
Beam Free model by default. Set another model with `POST /api/relay/projects`
and a `model` value in `provider/model` form. Set the projects directory with
the `discoveryRoot` value. The relay uses only its immediate subfolders. A run
that fails posts a short failure note into the chat.

## Relay logs

Start blibs from a terminal with `npm start` to see the relay logs. Search for
`blibs-relay` to see whether blibs skipped a request, matched a project,
started a harness, or queued a reply. Search for `blibs-outbox` to see if the
app acknowledged a send. The logs omit chat text, prompts, and harness output.

## Scripts

| Command | What |
|---|---|
| `npm run build` | Build the app |
| `npm start` | Launch the app (needs a prior `build`) |
| `npm test` | Rebuilds, runs unit and HTTP route tests, then runs the desktop harness with temporary stores and ports |
| `npm run e2e` | Build the app and run end-to-end checks; needs a display |
| `npm run test:built` | Run unit, HTTP, and headless harness checks against the current build |
| `npm run e2e:built` | Run desktop smoke checks against the current build |
| `npm run mock:desktop` | Open the built app with a temporary profile and mock sign-in |
| `npm run e2e:live` | Opt-in live checks; needs `BLIBS_LIVE_LOGIN=1`. The sign-in check also needs account values in `.env` |
| `npm run test:desktop` | Test search and citations; needs a display, but no model downloads |
| `npm run smoke` | Check that the app starts; needs a display |
| `npm run lint` | Check the code for lint errors |
| `npm run icons` | Regenerate the app PNG sizes, the macOS `.icns`, and the panel favicon from `assets/icon.svg`; needs macOS |
| `npm run clean` | Wipe `build/` + `dist/` |
| `npm run verify:clean-build` | Delete generated output, rebuild with the existing incremental cache, and check that all required output was regenerated |

CI runs the build, lint, and test checks on Linux and Windows for every push
and pull request.

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

If the provider is already signed in, follow the
[authenticated provider workflow](.agents/skills/verification/SKILL.md#authenticated-provider-checks)
to test the changed path in the built app. The automated scripts below
exercise specific flows and can send commands to a real account. Check their
side effects before running them.

### Live test scripts

`npm run e2e:live` runs two opt-in checks. Set `BLIBS_LIVE_LOGIN=1` to enable
them. Do not run these checks in CI.

1. **Sign-in check.** It uses a real Muse account and the Proton inbox that
   receives the verification code. Put `EMAIL_MUSE`, `PASSWORD_MUSE`, and
   `PROTON_URL` in the ignored `.env` file. The check reads the newest code,
   signs in, sends `@blibs`, and sends `@opencode hi` to the deterministic
   harness stub. It keeps its Electron profile in
   `tests/e2e/artifacts/live-profile`, so a remembered device works on the next
   run.
2. **Popout relay check.** It opens the authenticated Muse popout, sends
   `/clear`, `@blibs`, and a user `@opencode` tag. blibs ignores that user tag.
   The check then imports provider choice messages to list projects and run a
   task in the selected project.
   It uses the installed app profile and runs the real OpenCode model. Set
   `BLIBS_LIVE_PROFILE` to use another profile. The check reads the model and
   projects directory from the app state. Set `BLIBS_LIVE_MODEL` to override the
   model.

Do not commit the profile, a screenshot of a signed-in session, or a
credential. The popout check writes
`tests/e2e/artifacts/live-project-session-choices.png`; Git ignores that
directory.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '…/build/main/index.js'` on `npm start` | You skipped the build — run `npm run build` first (`build/` is generated) |
| `Electron failed to install correctly` | Use Node.js 24.x. If npm blocked the install script, run `npm install-scripts approve electron`, then `npm ci` again |
| Weird behavior right after `npm start` | Make sure `ELECTRON_RUN_AS_NODE` is **not** exported in your shell (`unset` it and remove it from `~/.zshrc` — it makes Electron act as plain Node) |
| Blibs: `Backend unreachable` pill | Backend didn't boot with the app — restart; check the terminal for `[blibs] proxy exited` |
| `EADDRINUSE` on `:5174`/`:8787` in `npm test` | A previous app instance is still running — quit it first |
| Send stuck on `Sending…` | Session not signed in or page still loading — use Agents, then Retry |
| Harness run shows `harness exited with code 1` | Check the OpenCode model and account limits. Set another model with `POST /api/relay/projects` and `{"model":"provider/model"}`. |
| Login lost after restart | Partitions persist per OS user; check you didn't clear app data |

## Limits (honest POC notes)

**Connections:** The relay stores the OpenCode switch and the shared folder.
When the switch is off, the relay starts no OpenCode work. The `@blibs`
introduction uses the same setting. Open **Connections** to see the folder that
the relay uses. A folder save error appears beside the folder editor.

**Conversation search:** Use the search bar in the topbar. It searches all
retained conversations after a short pause, and Enter runs the search at once.
Add a tag such as `#muse` to limit the search to one provider. Cmd+F on macOS or
Ctrl+F elsewhere focuses the bar. The sidebar gear opens Settings for the index
controls, **Ask locally**, the thread and date filters, and the theme. Keyword
search works without model setup. Optional free local BGE embeddings add semantic
retrieval, and a small local Qwen model can select cited evidence sentences.
Local answering is experimental: accurate quotes can still be irrelevant or
incomplete. Review the sources. Read [setup, migration, and test
instructions](docs/conversation-search.md) before enabling models. Runtime data
now lives in Electron's user-data history directory, with a preserved legacy
JSON backup; retained history is not capped at the panel's 500 messages.

- Only sees what's rendered in the **logged-in in-app sessions**. Mobile apps
  and WhatsApp/Slack DMs are out of reach.
- Sending is best-effort DOM automation (fill composer → click send); vendors
  redesign pages, selectors need maintenance — failures always surface with a reason.
- Personal use on your own accounts; check vendor ToS before productizing.
