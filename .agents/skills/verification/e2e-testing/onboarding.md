# Verify onboarding and first run

## Scope

This document covers the first-run connections screen, the harness matrix, the
shared folder, Start chatting, Escape, the route to the agents screen, and the
saved completion state.

It does not cover a real vendor sign-in. Use [vendor-login.md](vendor-login.md)
for the mock sign-in steps. It does not cover the connected chat, the setup card,
or the context column. Use [connections-chat.md](connections-chat.md) for those
items.

## Setup

See [shared setup](README.md#shared-setup).

- A fresh profile with no `blibs-onboarding-v1` key. The shared command starts
  a new profile.

## Test steps

1. Start the mock app with the shared command.
   Expected: the connections screen shows before the chat shell. The heading is
   `Connect your AI assistants to this computer`. The chat sidebar is not present.

2. Read the matrix.
   Expected: OpenCode for Muse is the only switch. It is on in a fresh
   profile. The other eight cells show `Unsupported`.

3. Read the shared folder.
   Expected: The path matches `discoveryRoot` at
   `"$BLIBS_BACKEND_URL/api/relay"`. The folder editor and navigation
   controls are available.

4. Focus `OpenCode for Muse` and press Space. Reload the page.
   Expected: The switch stays off. Press Space again to turn it on.

5. Select `Change folder`. Enter the path to an existing file. Select `Save`.
   Expected: The editor shows an error and stays open. Select `Cancel`.
   The previous folder remains selected.

6. Press Escape.
   Expected: the chat shell shows. The connections screen does not show again
   after a reload.

7. Reset both keys, then select `Connect another assistant`:

   ```js
   localStorage.removeItem('blibs-onboarding-v1');
   localStorage.removeItem('blibs-connections-v1');
   location.reload();
   ```

   Expected: the agents screen shows. Continue with
   [vendor-login.md](vendor-login.md). Select `Back to chats` or press Escape.
   Expected: the chat shell shows, and the first-run screen does not return.

8. Reset the onboarding key only, then select `Start chatting`.
   Expected: the chat shell shows. The saved `blibs-onboarding-v1` value is
   `done`. A reload does not show the connections screen again.

## Diagnostics

- The console shows a React or storage error.

Smoke screenshots: `onboarding-dark.png` and `onboarding-light.png`.

## Automated coverage

`tests/e2e/smoke.spec.ts`, test
`first run shows the connections matrix and does not reappear`, covers the
matrix, the keyboard switch, the shared folder, Start chatting, completion,
reload persistence, and both theme screenshots. `tests/connections.test.ts`
covers the state module: defaults, saved values, bad data, harness changes, the
folder, and setup derivation. `tests/e2e/harness.ts` provides
`resetOnboarding`, `completeOnboarding`, `seedConnections`,
`mockConnections`, and `CONNECTIONS_STORAGE_KEY`.
