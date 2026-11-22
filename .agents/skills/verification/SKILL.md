---
name: verification
description: Verify user-facing behavior in the signed-in app and check changes to modeled behavior.
---

# Verify a blibs feature

## User-facing behavior

For every user-facing change, including UI-only changes, exercise the
affected flow in the built app with the existing signed-in profile. Select
the [E2E guide](e2e-testing/README.md). Use passing automated checks for
the steps they cover. Use mock or temporary profiles for controlled states
such as first run, signed-out screens, and simulated failures. For those
states, also verify the relevant transition into or out of the signed-in
experience when possible. Record the blocker if a live check cannot run.
Keep unit, HTTP, and mock desktop tests isolated from real accounts.

## Formal verification

Use the [formal verification guide](formal-verification/README.md) when a
change affects a model or behavior it covers, including through shared
code. Run the model check and the relevant implementation tests.

Report results and skips and select PR screenshots using
[validate](../validate/SKILL.md#2-update-guides-and-record-evidence).

## Authenticated provider checks

Prefer targeted automated E2E against the existing signed-in profile.
Use that profile directly for checks and screenshots without confirmation.
For changes to provider sync or delivery, add or update a test when the
changed behavior lacks coverage. Use the current conversation or a test
conversation. Send synthetic verification messages when needed without
asking. Use an
isolated project for real harness runs. Check the side effects before running
a script. The Muse popout script sends `/clear`. Ask before clearing chats or
changing account settings. CI uses mock data.

If automation is blocked, verify by hand when possible and report the
blocker. Build the checkout and launch with `npm start`. For a custom
authenticated profile, pass `-- --user-data-dir="/path/to/profile"`.
Use one app instance per profile. Quit the old instance cleanly if it
would not interrupt active work. If sign-in or a CAPTCHA appears, ask the
user to complete it in the app.
