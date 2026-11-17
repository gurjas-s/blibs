/** Theme preference and the resolved token set for the panel. */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ThemeName = 'light' | 'dark';

/** Storage key for the saved theme preference. */
export const THEME_STORAGE_KEY = 'blibs-theme-v1';
/** Media query that reports the operating-system color scheme. */
export const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Read the saved choice. Default to the system preference on first run. */
export function readThemePreference(storage: Pick<Storage, 'getItem'> = localStorage): ThemePreference {
  const raw = storage.getItem(THEME_STORAGE_KEY);
  if (!raw) return 'system';
  try {
    const parsed: unknown = JSON.parse(raw);
    return isThemePreference(parsed) ? parsed : 'system';
  } catch {
    return 'system';
  }
}

/** Resolve a preference to one theme name. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ThemeName {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

/** Return true when the operating system asks for the dark theme. */
export function systemPrefersDark(): boolean {
  return window.matchMedia(SYSTEM_THEME_QUERY).matches;
}

/** Apply the token set for a preference to the document root. */
export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(preference, systemPrefersDark());
}

/** Apply the saved choice before the first paint. */
export function applyStoredTheme(): void {
  applyTheme(readThemePreference());
}
