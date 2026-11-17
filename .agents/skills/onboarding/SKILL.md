---
name: onboarding
description: Set up a fresh blibs checkout and start the app. Use on a new machine, a new clone, or when the app does not start.
---

# Onboard a fresh checkout

Follow these steps from the repository root.

## 1. Check Node.js

Run `node -v`.

The output must start with `v24.`.

Electron 34 does not install with a newer Node.js release. Use `fnm use 24`
or `nvm use 24` before you install.

## 2. Install

Run `npm ci`.

If npm blocks Electron's install script, run
`npm install-scripts approve electron`, then run `npm ci` again.

Check that `node_modules/electron/path.txt` exists. If it does not exist,
delete `node_modules`, then run `npm ci` again.

## 3. Build

Run `npm run build`.

## 4. Start

Run `npm start`.

## 5. Log in to the vendor sessions

Use **Agents → Log in to Muse / Dots / Grok** one time for each vendor.

The login window shares cookies with the hidden sync view. You can close the
login window after the login. Syncing continues in the background.

## Boundary: no vendor login for contributors

Do not ask a contributor, a reviewer, or CI to log in to a vendor.

Do not commit credentials, cookies, session data, or screenshots of a
logged-in vendor session. Keep sessions in Electron's persistent partitions.

Stop and ask the user to sign in when a vendor needs credentials or a CAPTCHA.

## 6. Check the checkout

Run `npm run lint` and `npm test`.

Then use the `validate` skill for each change.
