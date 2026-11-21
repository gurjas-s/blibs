---
name: verification
description: Verify changed user-facing behavior with a feature guide or an authenticated provider test.
---

# Verify a blibs feature

Select the [feature guide](e2e-testing/README.md). Use passing automated
checks for steps they cover. Run the remaining applicable steps. Use mock
sessions for startup, first run, and hard-to-reproduce failures.
Report results and skips and select PR screenshots using [validate](../validate/SKILL.md#evidence).

## Authenticated provider checks

Prefer targeted automated E2E against the existing signed-in profile.
Use that profile directly for checks and screenshots without confirmation.
For changes to provider sync or delivery, add or update a test when the
changed behavior lacks coverage. Use a dedicated test conversation,
synthetic messages, and an isolated project for real harness runs. Check
the side effects before running a script. The Muse popout script sends
`/clear`. Ask before clearing chats, changing account settings, or sending
messages outside the dedicated test conversation. CI uses mock data.

If automation is blocked, verify by hand when possible and report the
blocker. Build the checkout and launch with `npm start`. For a custom
authenticated profile, pass `-- --user-data-dir="/path/to/profile"`.
Use one app instance per profile. Quit the old instance cleanly if it
would not interrupt active work. If sign-in or a CAPTCHA appears, ask the
user to complete it in the app.
