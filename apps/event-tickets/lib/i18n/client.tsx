"use client";

import { createContext, useContext, useMemo } from "react";
import { dictFor, type Dict } from "./index.ts";
import { DEFAULT_LOCALE, type Locale } from "./locales.ts";

type I18nValue = { locale: Locale; t: Dict };

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  t: dictFor(DEFAULT_LOCALE),
});

/** Seeded from the server (layout) with the cookie's locale, so client and server agree on first paint. */
export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const value = useMemo(() => ({ locale, t: dictFor(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The dictionary for the current language. */
export function useT(): Dict {
  return useContext(I18nContext).t;
}

/** The current language, for date/amount formatting. */
export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
