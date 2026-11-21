---
name: design
description: Apply the blibs component, theme, and accessibility rules when changing renderer UI.
---

# Change the blibs UI

- Reuse controls in `src/renderer/components/`. Extend a shared component
  with a typed prop when the new state is a genuine variant.
- Use `src/renderer/styles/tokens.css` for color, spacing, type size, radius,
  and elevation. Give new tokens light and dark values. Keep the flat slate
  theme and one accent color. Use labels and helper text when they help the
  user act. Skip decorative badges and gradients.
- Keep shared state in `App` and search state in `SearchPanel`. Follow
  the [renderer boundaries](../../../AGENTS.md#architecture).
- Use native controls with accessible names, visible focus, and full
  keyboard access. Use semantic headings, hide decorative items from
  assistive technology, and announce asynchronous updates when needed.
- Check affected states for WCAG AA text contrast in both themes. Use
  [validate](../validate/SKILL.md) for test selection and screenshots.
