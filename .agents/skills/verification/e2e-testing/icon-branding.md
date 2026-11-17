# Verify icon and branding

## Scope and non-goals

This document covers the `b` brand mark, the `blibs` wordmark, the document
title, the window title, the favicon, the static icon file, the vendor product
names, the monogram avatars, the external link labels, and the app menu labels.

It does not cover a packaged installer icon. The repository has no packaging
step for a native app icon. It does not cover a redesign or a new color.

## Preconditions and setup

- Node.js 24 and `npm ci`.
- A successful `npm run build`.
- A display for `npm run e2e` and the mock app.
- A temporary profile.
- No vendor account.

The brand assets are `public/favicon.svg`, `public/icons.svg`, and the `mark`
element in the shell. The build copies the public assets to `dist/`.

## Test steps

1. Run `npm run build`.
   Expected: exit code 0. The command writes `dist/index.html` and the public
   assets.

2. Check the generated favicon and icon file:

   ```sh
   test -f dist/favicon.svg && test -f dist/icons.svg && echo ok
   ```

   Expected: `ok`.

3. Check the document title:
   `grep -o '<title>[^<]*</title>' dist/index.html`.
   Expected: `<title>blibs — personal-agent control panel</title>`.

4. Run `npm run verify:clean-build`.
   Expected: exit code 0. The output ends with
   `Clean build regenerated the app, preload, backend, panel, and CommonJS markers.`
   Run step 2 again. Expected: `ok`.

5. Run `npm run e2e`.
   Expected: exit code 0. The smoke test reads the page title and asserts that
   it matches `/blibs/`. The test writes
   `tests/e2e/artifacts/panel-dark.png` and
   `tests/e2e/artifacts/panel-light.png`.

6. Start the mock app with the shared command.
   Expected: the window title is `blibs — personal-agent control panel`. The
   top bar shows a square accent-colored mark with the letter `b` and the
   `blibs` wordmark.

7. Complete the first-run card if it shows.
   Expected: the first-run card shows the same `b` mark and the `blibs`
   wordmark. The chat shell keeps one brand block in the top bar. The page does
   not show a Vite or React logo.

8. Fetch the favicon from the panel server:
   `curl -sI http://127.0.0.1:5199/favicon.svg`.
   Expected: status `200 OK` and `Content-Type: image/svg+xml`.

9. Fetch the start of the favicon:
   `curl -s http://127.0.0.1:5199/favicon.svg | head -c 60`.
   Expected: the output starts with `<svg` and contains a `viewBox`.

10. Select `Agents and sign-in`.
    Expected: the cards show `Muse`, `Dots`, and `Grok`. The vendor names are
    `Meta`, `OpenAI`, and `xAI`. Each avatar shows the first letter of the
    product name. The avatars are decorative.

11. Return to the chat shell. Read the thread header.
    Expected: the action is `Open Muse ↗` or the matching product name. The
    link opens the approved vendor host in an app window. It does not navigate
    the panel.

12. Open the application menu.
    Expected: the `Agents` menu has `Sign in to Muse…`, `Sign in to Dots…`,
    `Sign in to Grok…`, a separator, and `Reload vendor views`. The `View` menu
    has `Reload`, `Toggle Developer Tools`, and `Quit`.

13. Manual boundary: the external vendor link can open a vendor sign-in
    window. Do not sign in during a review. Do not commit a screenshot of a
    signed-in vendor page.

## Failure signals and artifacts

- `dist/favicon.svg` or `dist/icons.svg` is missing.
- The favicon request returns 404 or the wrong content type.
- The document title is empty, generic, or from a template.
- The page shows a Vite or React logo.
- The `b` mark or the `blibs` wordmark is missing.
- A vendor product name or vendor name is wrong.
- An avatar is exposed to assistive technology as content.
- A vendor link navigates the panel or opens an unapproved host.
- The `Agents` or `View` menu is missing.

Artifacts:

- The `dist/` file list
- The `/favicon.svg` response headers and first bytes
- `tests/e2e/artifacts/panel-dark.png`
- `tests/e2e/artifacts/panel-light.png`
- The `npm run e2e` terminal output

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Keep the screenshots only for the pull request body.

## Automated tests that cover it

- `tests/e2e/smoke.spec.ts`, test
  `panel shows a selected chat and a readable message thread`, asserts that the
  page title matches `/blibs/`. Run `npm run e2e`.
- `npm run verify:clean-build` checks that a clean build writes
  `dist/index.html`. It does not check the favicon.
- `npm run build` copies the `public/` assets. No test checks the copied asset
  list.
- No automated test covers the app menu labels, the brand mark, or the vendor
  link host check. This is a test gap. State the gap in the pull request.
