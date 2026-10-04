/**
 * An event's accent: one colour taken from its poster, used for a few
 * touches (a soft background, a link colour) on the event's own screens.
 *
 * It is cosmetic, but it ends up inside CSS, so the only thing ever accepted
 * or emitted is `#rrggbb` ({@link parseAccent}); every value handed to the UI
 * is built here from numbers, never echoed from input. Pure: the tests run it
 * under `node --test`.
 */

/** The request header that carries the accent next to the photo's bytes. */
export const ACCENT_HEADER = "x-event-accent";

const ACCENT_RE =/^#[0-9a-f]{6}$/i;

/** Strict: `#rrggbb`, nothing else (no names, no `rgb()`, no `#rgb`, no trailing text). Returned lowercase. */
export function parseAccent(raw: unknown): string | null {
  return typeof raw === "string" && ACCENT_RE.test(raw) ? raw.toLowerCase() : null;
}

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    const x = (t + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

/** `accent` mixed over `base` at `amount` (0 = base, 1 = accent). */
function mix(accent: string, base: string, amount: number): string {
  const a = hexToRgb(accent);
  const b = hexToRgb(base);
  return rgbToHex([0, 1, 2].map((i) => b[i] + (a[i] - b[i]) * amount) as Rgb);
}

/** AA for normal-size text. */
export const AA_CONTRAST = 4.5;

/**
 * Keeps the accent's hue and saturation and moves only its lightness (toward
 * dark when `direction` is -1, toward light when 1) until the colour reaches
 * AA against every background in `against`. Black and white always get there,
 * so the loop always ends.
 */
function adjustForContrast(accent: string, against: string[], direction: -1 | 1): string {
  const [h, s, l0] = rgbToHsl(hexToRgb(accent));
  const ok = (hex: string) => against.every((bg) => contrastRatio(hex, bg) >= AA_CONTRAST);
  let hex = accent;
  for (let step = 0; step <= 100 && !ok(hex); step++) {
    const l = Math.min(1, Math.max(0, l0 + (direction * step) / 100));
    hex = rgbToHex(hslToRgb([h, s, l]));
  }
  return ok(hex) ? hex : direction === -1 ? "#000000" : "#ffffff";
}

/** The page backgrounds in app/globals.css. UI code never passes colours of its own; these only anchor the contrast maths. */
export const LIGHT_BACKGROUND = "#ffffff";
export const DARK_BACKGROUND = "#0a0e14";

export type AccentVariants = {
  /** The accent itself, normalised (for the poster frame, a border, a glow: never for small text). */
  accent: string;
  /** A soft wash of the accent over the light background, and over the dark one. */
  softLight: string;
  softDark: string;
  /** Text colours with AA contrast (4.5:1) on the light background AND its soft wash / on the dark one AND its soft wash. */
  textOnLight: string;
  textOnDark: string;
  /** Black or white, whichever reads better on a solid accent (a button, a badge). */
  onAccent: string;
};

/**
 * The safe variants of an accent for the UI, or null when there is none (no
 * photo, no accent, or a value that isn't `#rrggbb`): the UI then uses its
 * normal tokens.
 */
export function accentVariants(
  accent: unknown,
  backgrounds: { light?: string; dark?: string } = {}
): AccentVariants | null {
  const base = parseAccent(accent);
  if (!base) return null;
  const light = parseAccent(backgrounds.light) ?? LIGHT_BACKGROUND;
  const dark = parseAccent(backgrounds.dark) ?? DARK_BACKGROUND;
  const softLight = mix(base, light, 0.14);
  const softDark = mix(base, dark, 0.22);
  return {
    accent: base,
    softLight,
    softDark,
    textOnLight: adjustForContrast(base, [light, softLight], -1),
    textOnDark: adjustForContrast(base, [dark, softDark], 1),
    onAccent: contrastRatio(base, "#ffffff") >= contrastRatio(base, "#000000") ? "#ffffff" : "#000000",
  };
}

/**
 * CSS custom properties for a style attribute (`style={accentStyle(accent)}`);
 * the screens then use `var(--event-accent-soft)` etc. Null for no accent.
 * Light and dark pairs are both given: the UI picks by theme.
 */
export function accentStyle(accent: unknown): Record<string, string> | null {
  const v = accentVariants(accent);
  if (!v) return null;
  return {
    "--event-accent": v.accent,
    "--event-accent-soft-light": v.softLight,
    "--event-accent-soft-dark": v.softDark,
    "--event-accent-text-light": v.textOnLight,
    "--event-accent-text-dark": v.textOnDark,
    "--event-accent-on": v.onAccent,
  };
}

/**
 * A representative colour of a picture, from its RGBA pixels (a small
 * downscaled copy; the browser makes it). The most common colours win, but
 * vivid ones count extra and near-black, near-white and transparent pixels
 * don't count at all, so a poster with a white margin still gives its ink.
 * Null when nothing usable is left (a black-and-white photo, say): then the
 * poster simply has no accent.
 */
export function dominantColor(rgba: ArrayLike<number>): string | null {
  const buckets = new Map<number, { weight: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    if (rgba[i + 3] < 200) continue;
    const [, s, l] = rgbToHsl([r, g, b]);
    if (l < 0.12 || l > 0.92 || s < 0.15) continue;
    // 4 bits per channel: 4096 buckets, close shades vote together.
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const weight = 0.25 + s;
    const bucket = buckets.get(key) ?? { weight: 0, r: 0, g: 0, b: 0 };
    bucket.weight += weight;
    bucket.r += r * weight;
    bucket.g += g * weight;
    bucket.b += b * weight;
    buckets.set(key, bucket);
  }
  let best: { weight: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) if (!best || bucket.weight > best.weight) best = bucket;
  if (!best) return null;
  return rgbToHex([best.r / best.weight, best.g / best.weight, best.b / best.weight]);
}
