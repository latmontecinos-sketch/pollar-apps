import { accentVariants } from "@/lib/accent";

/**
 * Paints the page behind an event with the event's wash, all the way down.
 *
 * The event page tints its own wrapper (`.event-tint`, app/globals.css), but
 * the footer the root layout draws sits outside that wrapper, so on the
 * default `body` color it would show as a seam. This puts the same wash on
 * `body` when the page has an event's tint on it.
 *
 * What goes into the stylesheet is only ever `#rrggbb` built from numbers by
 * `accentVariants` (lib/accent.ts), never the stored string.
 */
export function EventTintStyle({ accent }: { accent: string | null }) {
  const variants = accentVariants(accent);
  if (!variants) return null;
  const css = [
    `body:has(.event-tint){background:${variants.softLight}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) body:has(.event-tint){background:${variants.softDark}}}`,
    `:root[data-theme="dark"] body:has(.event-tint){background:${variants.softDark}}`,
  ].join("");
  return <style>{css}</style>;
}
