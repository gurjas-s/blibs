# Verify icon and branding

## Scope and non-goals

This document covers the `b` brand mark, the `blibs` wordmark, the document
title, the window title, the favicon, the static icon file, the vendor product
names, the monogram avatars, the external link labels, and the app menu labels.

It does not cover a packaged installer icon. The repository has no packaging
step for a native app icon. It does not cover a redesign or a new color.

## Preconditions and setup

Shared setup: see [README.md](README.md).

## Test steps

1. Start the mock app with the shared command.
   Expected: the window title is `blibs — personal-agent control panel`. The
   top bar shows a square accent-colored mark with the letter `b` and the
   `blibs` wordmark.

2. Check the built assets and the document title:

   ```sh
   test -f dist/favicon.svg && test -f dist/icons.svg && echo ok
   grep -o '<title>[^<]*</title>' dist/index.html
   ```

   Expected: `ok` and `<title>blibs — personal-agent control panel</title>`.

3. Complete the first-run card if it shows.
   Expected: the card shows the same `b` mark and `blibs` wordmark. The chat
   shell keeps one brand block in the top bar. No Vite or React logo shows.

4. Fetch the favicon from the panel server:
   `curl -sI http://127.0.0.1:5199/favicon.svg`.
   Expected: status `200 OK` and `Content-Type: image/svg+xml`. Fetch the start
   with `curl -s http://127.0.0.1:5199/favicon.svg | head -c 60`.
   Expected: the output starts with `<svg` and contains a `viewBox`.

5. Select `Agents and sign-in`.
   Expected: the cards show `Muse`, `Dots`, and `Grok`. The vendor names are
   `Meta`, `OpenAI`, and `xAI`. Each avatar shows the first letter of the
   product name and is decorative.

6. Return to the chat shell. Read the thread header.
   Expected: the action is `Open Muse ↗` or the matching product name. The link
   opens the approved vendor host in an app window. It does not navigate the
   panel.

7. Open the application menu.
   Expected: the `Agents` menu has `Sign in to Muse…`, `Sign in to Dots…`,
   `Sign in to Grok…`, a separator, and `Reload vendor views`. The `View` menu
   has `Reload`, `Toggle Developer Tools`, and `Quit`.

8. Manual boundary: an external vendor link can open a vendor sign-in window.
   Do not sign in during a review. Do not commit a screenshot of a signed-in
   vendor page.

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

Artifacts: `tests/e2e/artifacts/panel-dark.png` and `panel-light.png`, the
`/favicon.svg` response headers, and the first bytes of the file.

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
  `dist/index.html`. The build copies the `public/` assets.
- No automated test covers the copied favicon, the app menu labels, the brand
  mark, or the vendor link host check. This is a test gap. State the gap in the
  pull request.
