/**
 * An event's city: short, optional, written the same way every time so the
 * showcase's filter chips ("La Paz", "Santa Cruz") don't split into "la paz",
 * "La Paz " and "LA PAZ".
 *
 * Pure (no imports): the tests run it under `node --test`.
 */

export const MAX_CITY_CHARS = 60;

/** Suggestions for the form's datalist. Any other city is accepted: there are events outside Bolivia. */
export const BOLIVIA_CITIES = [
  "La Paz",
  "El Alto",
  "Santa Cruz",
  "Cochabamba",
  "Sucre",
  "Oruro",
  "Potosí",
  "Tarija",
  "Trinidad",
  "Cobija",
] as const;

/** Connectors that stay lowercase inside a name ("Ciudad de México", "Rio de Janeiro"). */
const LOWERCASE_WORDS = new Set(["de", "del", "la", "las", "los", "el", "y", "da", "do", "of", "the", "and"]);

/** "Potosí" and "potosi" are the same city: compare without accents or case. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es");
}

const SUGGESTION_BY_FOLDED = new Map<string, string>(BOLIVIA_CITIES.map((city) => [fold(city), city]));

/**
 * What gets stored: trimmed, inner whitespace collapsed, control characters
 * dropped, capped at {@link MAX_CITY_CHARS}, and capitalised word by word
 * (connectors like "de" stay lowercase). A known suggestion comes back in its
 * canonical spelling, accents included. Null when nothing is left — no city.
 */
export function normalizeCity(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
     
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CITY_CHARS)
    .trim();
  if (!cleaned) return null;

  const known = SUGGESTION_BY_FOLDED.get(fold(cleaned));
  if (known) return known;

  const words = cleaned.toLocaleLowerCase("es").split(" ");
  return words
    .map((word, index) => {
      if (index > 0 && LOWERCASE_WORDS.has(word)) return word;
      // Capitalise the first letter of the word and of each hyphenated part.
      return word.replace(/(^|-)(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toLocaleUpperCase("es"));
    })
    .join(" ");
}
