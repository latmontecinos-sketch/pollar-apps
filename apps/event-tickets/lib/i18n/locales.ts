export const LOCALES = ["es", "en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "es";
export const LOCALE_COOKIE = "pollarpass_locale";

/** Shown in the preferences modal — each language named in itself. */
export const LOCALE_LABELS: Record<Locale, string> = {
  es: "Español",
  en: "English",
  fr: "Français",
};

/** Intl tags: dates and amounts follow the reader's language, never the device's. */
export const INTL_LOCALE: Record<Locale, string> = {
  es: "es-BO",
  en: "en-US",
  fr: "fr-FR",
};

export function isLocale(value: string | undefined | null): value is Locale {
  return LOCALES.includes(value as Locale);
}

/** First supported language in an `Accept-Language` header, for a visitor with no cookie yet. */
export function localeFromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return null;
}
