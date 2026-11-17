---
name: design
description: Add or change UI in the blibs renderer. Use this skill before you add a component, a color, a control, or a panel state.
---

# Add UI to blibs

The blibs renderer is a component layer with design tokens. The shell task owns
the page layout. Your task owns the components and the states that it uses.

## 1. Reuse a component first

Look in `src/renderer/components/`. Use the existing components:

- `Button`, `LinkButton` for actions.
- `TextField`, `SelectField`, `CheckboxField` for input.
- `Card`, `EmptyState` for grouped content.
- `StatusPill`, `Avatar`, `SectionLabel` for small display items.
- `AgentListItem`, `MessageBubble` for chat-specific items.

Do not write a second button, input, card, or status pill. Extend a component
with a typed prop when the new state is a real variant.

## 2. Use tokens

Read `src/renderer/styles/tokens.css`. Use a token for each color, space, font
size, radius, and shadow.

- Use `var(--color-…)`, `var(--space-…)`, `var(--font-size-…)`,
  `var(--radius-…)`, and `var(--elevation-…)`.
- Do not write a raw color, a raw pixel space, or a raw shadow in a component.
- Keep one accent color. Do not add a second accent.
- Do not use a gradient.
- Do not add an unnecessary chip, badge, or pill.
- Do not add a caption that explains the screen. Use a label or a helper only
  when the user must act on it.

Both themes must stay in sync. Add a light value and a dark value to
`tokens.css` when you add a token. The shell applies `data-theme="light"` or
`data-theme="dark"` on the root element.

## 3. Keep components pure

A component gets data through typed props and reports actions through typed
callbacks.

- Do not call `fetch` in a component.
- Do not read or write `localStorage` in a component.
- Do not import the backend, Electron, a Node module, or a vendor page.
- Put data access in `src/renderer/client.ts`. Add a typed function there when
  the backend route is new.

The `App` module owns state. The `SearchPanel` module owns its search state.
Keep that split.

## 4. Make it accessible

- Give each control an accessible name. Use `label`, `aria-label`, or visible
  text.
- Keep a visible focus state. Use the shared focus ring, or a token-based
  border and `box-shadow`.
- Use a native element for its job. Use `button` for an action and `a` for
  navigation.
- Keep keyboard access. Do not block Tab, Enter, or Space.
- Use a semantic heading order. Do not use a heading for visual size only.
- Keep text contrast at WCAG AA or better in both themes. Check body text,
  muted text, status text, and text on the accent color.
- Mark a decorative item with `aria-hidden="true"`.
- Use `aria-live` for a result that changes without a user action.

## 5. Test with mocked data

Do not use a live vendor login in a test or a screenshot.

- Use `tests/e2e/harness.ts` to start the real app with a temporary profile and
  store. The app needs no vendor login.
- Seed or mock the state that the component needs.
- Add an e2e check in `tests/e2e/` when the change affects the panel.
- Check the default dark theme and the light theme. Call `setTheme` from the
  harness, or set `document.documentElement.dataset.theme`.

## 6. Capture a screenshot

A visible change needs a screenshot in the pull request.

- Use `npm run e2e`. It writes `tests/e2e/artifacts/panel-dark.png` and
  `tests/e2e/artifacts/panel-light.png`.
- Attach the files to the pull request body with
  `gh pr edit <number> --attach <path>`. Never commit them.
- Use mocked data in the screenshot. Do not show a logged-in vendor session,
  a cookie, or a credential.

## 7. Run the checks

Run these commands before review:

```sh
npm run build
npm run lint
npm test
npm run e2e
```

`npm run lint` must pass with no warnings. `npm test` must pass. `npm run e2e`
needs a display.

For the full review flow, use the `validate` skill.
