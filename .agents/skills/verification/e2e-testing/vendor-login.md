# Verify vendor login and sessions

## Scope

This document covers the agents screen, the in-app sign-in entry point, the
inline sign-in steps, `Check again`, `Open website`, `Cancel`, `Back to chats`,
Escape, and the persistent vendor partition.

It does not cover a real vendor account, a verification code, or a CAPTCHA. It
does not cover chat sync or message sending.

## Setup

See [shared setup](README.md#shared-setup).

## Test steps

1. Start the mock app with the shared command. Complete the first-run card.
   Expected: the chat shell shows.

2. Select `Agents`.
   Expected: the heading is `Agents`. The cards are `Muse`, `Dots`, and `Grok`.
   Each card shows `Not signed in. Select Sign in to open the provider website in blibs.`
   The `Back to chats` button is visible.

3. Select `Sign in` on the Muse card.
   Expected: the status is
   `Enter the mobile verification code in the Muse website, then select Check again.`
   The card shows `Check again`, `Open website`, and `Cancel`.

4. Select `Check again`.
   Expected: the status is
   `Signed in to Muse. The session stays on this device.` The primary button is
   `Sign in again`.

5. Select `Sign in again`, wait for the verification step, then select
   `Cancel`.
   Expected: the status is `Sign-in cancelled for Muse. You can try again.`

6. Press `Escape`. Open the agents screen again, then select `Back to chats`.
   Expected: the chat shell returns both times.

7. Select Muse in the sidebar. Type `Text to copy` in the mock website's `Message` field. Select all, copy, clear the field, and
   paste using the system shortcuts. Press Escape while the field has focus.
   Expected: the text appears after paste. Escape leaves the website open.

8. For session persistence changes, start the built app with the
   [authenticated profile](../SKILL.md#authenticated-provider-checks).
   Open the provider from Agents, quit blibs, then repeat with the same
   profile. Expected: the provider session remains signed in across restart.
   The Agents card can start at `Not signed in` until it checks the session.

## Diagnostics

- The status shows a vendor error or an IPC error.

Smoke screenshots: `login-dark.png`, `login-light.png`,
`home-after-login-dark.png`, `home-after-login-light.png`, and `provider-controls.png`.

## Automated coverage

`tests/e2e/smoke.spec.ts`, test
`vendor sign-in entry point shows mocked steps and returns home`, covers the
agents screen, three vendor cards, the mocked verification step, `Check again`,
`Cancel`, a completed sign-in, Escape, and `Back to chats`. The provider pane uses a local page in this test.
