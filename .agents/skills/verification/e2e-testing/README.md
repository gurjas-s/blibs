# End-to-end verification for blibs

Select a guide for the changed feature. Use the
[verification skill](../SKILL.md) to decide which steps to run.

## Shared setup

Install the dependencies and build the app with the
[onboarding skill](../../onboarding/SKILL.md). Start a manual mock session
with `npm run mock:desktop`.

- The launcher prints the panel, backend, and DevTools URLs. Use those URLs
  in the steps. Set `BLIBS_PANEL_URL` and `BLIBS_BACKEND_URL` in the shell
  where you run the guide's commands.
- Each session uses its own ports, profile, history, fake harness, and
  temporary `alpha` and `beta` project folders.
- The mock sign-in uses scripted steps. Hidden vendor views can load public
  pages and stay signed out.
- Quit blibs or press Ctrl+C in the launcher terminal to stop the session and
  remove its temporary data.
- For checks, evidence, and display requirements, see
  [validate](../../validate/SKILL.md).

After building, run `npm run e2e:built` for the smoke suite. To run one
check, pass its name before the spec path:

```sh
node --import tsx --test --test-name-pattern='part of the test name' tests/e2e/smoke.spec.ts
```

The spec saves screenshots in `tests/e2e/artifacts/`.

## Feature map

| User-facing feature | Document | Main automated check |
| --- | --- | --- |
| Onboarding and first run | [onboarding.md](onboarding.md) | `smoke.spec.ts`: `first run shows the connections matrix and does not reappear` |
| Connections and assistant chat | [connections-chat.md](connections-chat.md) | `smoke.spec.ts`: `Connections applies the saved folder and harness setting to Muse requests`; `panel shows a selected chat and a readable message thread`; `connections.test.ts` |
| blibs introduction and harness replies | [blibs-intro.md](blibs-intro.md) | `smoke.spec.ts`: `an @blibs mention shows the introduction and a harness reply says which harness sent it`; `relay.test.ts` |
| OpenCode project selection | [project-selection.md](project-selection.md) | `smoke.spec.ts`: `scripted Muse creates a file in the requested project from the composer`; `relay.test.ts` |
| Vendor login and sessions | [vendor-login.md](vendor-login.md) | `smoke.spec.ts`: `vendor sign-in entry point shows mocked steps and returns home` |
| Chat and sending | [chat-sending.md](chat-sending.md) | `smoke.spec.ts`: `panel shows a selected chat and a readable message thread`; `proxy.test.ts`: outbox; `search-desktop.cjs`: delayed echo |
| Sync and status | [sync-status.md](sync-status.md) | `proxy.test.ts`: legacy imports; `test-harness.ts`: health and sweep |
| Theme and app shell | [theme-app-shell.md](theme-app-shell.md) | `smoke.spec.ts`: theme control and layout |
| Conversation search | [conversation-search.md](conversation-search.md) | `history.test.ts`; `search-desktop.cjs` |
| Icon and branding | [icon-branding.md](icon-branding.md) | `build`; `verify-clean-build`; `smoke.spec.ts`: title |

Use [write-verification-guide](../../write-verification-guide/SKILL.md) to
update or add a guide.
