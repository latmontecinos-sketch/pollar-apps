export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "system";
export const THEME_COOKIE = "pollarpass_theme";

export function isTheme(value: string | undefined | null): value is Theme {
  return THEMES.includes(value as Theme);
}

/**
 * What goes on `<html data-theme>`. "system" is left off the element so the
 * `prefers-color-scheme` rules in globals.css decide; "light"/"dark" pin it.
 */
export function themeAttribute(theme: Theme): Theme | undefined {
  return theme === "system" ? undefined : theme;
}

/** One year: a preference the visitor set by hand shouldn't quietly expire. */
export const PREFERENCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
