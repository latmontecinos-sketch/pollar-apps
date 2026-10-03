import { en } from "./en.ts";
import { es, type Dict } from "./es.ts";
import { DEFAULT_LOCALE, type Locale } from "./locales.ts";

export const DICTIONARIES: Record<Locale, Dict> = { es, en };

export function dictFor(locale: Locale): Dict {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
}

export type { Dict };
export * from "./locales.ts";
