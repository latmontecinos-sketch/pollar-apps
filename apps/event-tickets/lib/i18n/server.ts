import { cookies, headers } from "next/headers";
import { DEFAULT_THEME, isTheme, type Theme, THEME_COOKIE } from "../theme.ts";
import { dictFor, type Dict } from "./index.ts";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_COOKIE,
  localeFromAcceptLanguage,
  type Locale,
} from "./locales.ts";

/**
 * The reader's language: their saved choice, else what their browser asks
 * for, else Spanish. Read on the server so pages arrive already translated
 * (no flash of the wrong language, and link previews are translated too).
 */
export async function getLocale(): Promise<Locale> {
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return saved;
  return localeFromAcceptLanguage((await headers()).get("accept-language")) ?? DEFAULT_LOCALE;
}

export async function getDict(): Promise<{ locale: Locale; t: Dict }> {
  const locale = await getLocale();
  return { locale, t: dictFor(locale) };
}

/** Light/dark preference, applied to `<html>` server-side so there's no flash. */
export async function getTheme(): Promise<Theme> {
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  return isTheme(saved) ? saved : DEFAULT_THEME;
}
