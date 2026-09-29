"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  DEFAULT_THEME,
  PREFERENCE_COOKIE_MAX_AGE,
  THEME_COOKIE,
  themeAttribute,
  type Theme,
} from "./theme.ts";

type ThemeValue = { theme: Theme; setTheme: (next: Theme) => void };

const ThemeContext = createContext<ThemeValue>({ theme: DEFAULT_THEME, setTheme: () => {} });

/**
 * Seeded from the cookie the server already read, so the toggle renders in
 * the right position on the first paint (no hydration mismatch) and the
 * choice applies instantly, without a round trip.
 */
export function ThemeProvider({
  initial,
  children,
}: {
  initial: Theme;
  children: React.ReactNode;
}) {
  const [theme, setThemeState] = useState<Theme>(initial);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${PREFERENCE_COOKIE_MAX_AGE}; samesite=lax`;
    const attribute = themeAttribute(next);
    if (attribute) document.documentElement.dataset.theme = attribute;
    else delete document.documentElement.dataset.theme;
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}
