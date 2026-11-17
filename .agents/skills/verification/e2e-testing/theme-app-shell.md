# Verify theme and app shell

## Scope and non-goals

This document covers the theme control, the saved theme choice, the system
theme follow, the design tokens, the shell layout, the sidebar toggle, the
current-chat search field, and the status pill.

It does not cover the brand mark, the favicon, or the window title. Use
[icon-branding.md](icon-branding.md). It does not cover chat content or search
results.

## Preconditions and setup

Shared setup: see [README.md](README.md).

## Test steps

1. Start the mock app with the shared command. Complete the first-run card.
   Expected: the chat shell shows with the top bar, the sidebar, the thread,
   the composer, and the status pill.

2. Set the theme control to `Dark`.
   Expected: `document.documentElement.dataset.theme` is `dark`.
   `localStorage.getItem('blibs-theme-v1')` is `"dark"` with the JSON quotes.
   Reload the page. Expected: the control value is `Dark`, the dark token set
   paints before the first frame, and there is no flash of the light theme.

3. Set the theme control to `Light`.
   Expected: `data-theme` is `light` and the saved value is `"light"`.

4. Set the theme control to `System`. Set the operating system to dark, then to
   light.
   Expected: the page follows the system preference without a reload.

5. Read the required tokens in both themes:

   ```js
   const s = getComputedStyle(document.documentElement);
   ['--color-bg', '--color-surface', '--color-text', '--color-accent',
    '--space-2', '--font-size-base', '--radius-lg', '--elevation-1']
     .map((name) => [name, s.getPropertyValue(name).trim()]);
   ```

   Expected: each token has a value in both themes. The background and text
   values differ between the themes.

6. Resize the window to 1024, 1440, and 1600 pixels wide. Run this at each
   width:

   ```js
   const bar = document.querySelector('.search').getBoundingClientRect();
   const main = document.querySelector('.main').getBoundingClientRect();
   const actions = document.querySelector('.topbar-actions').getBoundingClientRect();
   const offCenter = Math.round(bar.left + bar.width / 2) - Math.round(main.left + main.width / 2);
   const overlaps = Math.round(bar.right) > Math.round(actions.left);
   const sideways = document.documentElement.scrollWidth - document.documentElement.clientWidth;
   const down = document.documentElement.scrollHeight - document.documentElement.clientHeight;
   ({ offCenter, overlaps, sideways, down });
   ```

   Expected: `offCenter` is `0` or `1`. The search bar is centered over the chat
   pane and does not move when the brand text or the sync state changes.
   `overlaps` is `false`. `sideways` is `0` or `1`. `down` is `0`, so the page
   has one scroll area and no double scrollbar. The sidebar is visible at 1024
   and wider.

7. Open Settings, the search results, and the Agents screen in turn. Expected:
   each view keeps the same content width and side gutter as the chat view.
   The result list scrolls inside its pane.

8. Return to a chat. Expected: the message thread starts below the topbar. The
   chat view has no provider title, no caption, and no open link. The composer
   is the last visible control, and no visible status line sits below it.

9. Resize the window to 800 by 800 pixels.
   Expected: the sidebar is hidden and the `Chats` button is visible. The
   search bar takes a full second row. Select `Chats`. Expected: the sidebar
   shows and `aria-expanded` is `true`. Select `Chats` again. Expected: the
   sidebar hides and `aria-expanded` is `false`.

10. Press `Tab` through the page. Expected: each control has a visible focus
    ring and the theme control changes with the arrow keys.

11. Check the text contrast in both themes. Check body text, muted text, status
    text, and text on the accent color. Expected: each pair meets WCAG AA or
    better.

## Failure signals and artifacts

- A required token is empty, or both themes use the same background or text
  value.
- The saved choice is missing after a reload, or the first paint uses the wrong
  theme.
- The system preference does not update the page without a reload.
- The layout scrolls sideways at 1024 or 1440 pixels.
- The search bar center is more than 1 pixel from the chat pane center, or the
  search bar overlaps the sync state.
- The chat view shows a provider title, a caption, an open link, or a visible
  status line below the composer.
- The page has a second vertical scrollbar, or a view breaks its content width
  or gutter.
- The sidebar is hidden at 800 pixels and the `Chats` button is missing.
- A control has no focus ring or a focus trap.
- A text pair fails WCAG AA.

Artifacts: `tests/e2e/artifacts/panel-dark.png` and `panel-light.png`.

## Cleanup

1. Quit the mock app. On macOS, press `Cmd+Q`. On Linux or Windows, close the
   window. Press `Ctrl+C` in the terminal when the process stays open.
2. Remove the temporary directory: `rm -rf "$TMP"`.
3. Attach the screenshots to the pull request body with
   `gh pr edit <number> --attach <path>`. Never commit them.

## Automated tests that cover it

- `tests/e2e/smoke.spec.ts`, test
  `theme control follows the system preference and persists the choice`, covers
  the `System` default, a dark system preference, a live system change, the
  saved `Dark` choice, persistence after a reload, the required tokens, and both
  theme screenshots.
- `tests/e2e/smoke.spec.ts`, test
  `panel shows a selected chat and a readable message thread`, covers the 1024
  and 1440 pixel layouts, the 800 pixel sidebar toggle, and horizontal scroll.
  Run `npm run e2e`.
- `tests/e2e/harness.ts` provides `selectTheme` and `setTheme`. No unit test
  covers the theme module.
