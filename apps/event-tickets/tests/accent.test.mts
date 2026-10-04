/** The poster accent (lib/accent.ts): what is accepted, and that every colour handed to the UI reads. Pure. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AA_CONTRAST,
  accentStyle,
  accentVariants,
  contrastRatio,
  DARK_BACKGROUND,
  dominantColor,
  LIGHT_BACKGROUND,
  parseAccent,
} from "../lib/accent.ts";

test("parseAccent takes #rrggbb and nothing else", () => {
  assert.equal(parseAccent("#1a2b3c"), "#1a2b3c");
  assert.equal(parseAccent("#1A2B3C"), "#1a2b3c", "normalised to lowercase");
  for (const bad of [
    "1a2b3c",
    "#1a2b3",
    "#1a2b3cd",
    "#abc",
    "#gggggg",
    "red",
    "rgb(1,2,3)",
    "#1a2b3c;",
    "#1a2b3c\n",
    " #1a2b3c",
    "#1a2b3c; background: url(//evil.example)",
    "#1a2b3c</style>",
    "",
    null,
    undefined,
    123,
    {},
    ["#1a2b3c"],
  ]) {
    assert.equal(parseAccent(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
});

test("no accent (or a bad one) means no variants: the UI keeps its own tokens", () => {
  assert.equal(accentVariants(null), null);
  assert.equal(accentVariants(undefined), null);
  assert.equal(accentVariants("blue"), null);
  assert.equal(accentStyle(null), null);
  assert.equal(accentStyle("#12"), null);
});

test("contrastRatio is the WCAG one", () => {
  assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 1e-9);
  assert.ok(Math.abs(contrastRatio("#ffffff", "#ffffff") - 1) < 1e-9);
  assert.ok(Math.abs(contrastRatio("#777777", "#ffffff") - 4.48) < 0.02);
});

// A spread of hues, lightnesses and the extremes: white, black, grays, pure primaries, near-backgrounds.
const SAMPLES: string[] = ["#ffffff", "#000000", "#808080", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#fefefe", "#0a0e14", "#0b0f15"];
for (let h = 0; h < 360; h += 15) {
  for (const [s, l] of [[100, 50], [90, 25], [60, 75], [30, 40], [100, 92], [70, 8]] as const) {
    SAMPLES.push(hslHex(h, s, l));
  }
}

function hslHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

test("the text colours reach AA against the page and the soft wash, in light and in dark, for any accent", () => {
  for (const accent of SAMPLES) {
    const v = accentVariants(accent);
    assert.ok(v, accent);
    assert.ok(contrastRatio(v.textOnLight, LIGHT_BACKGROUND) >= AA_CONTRAST, `${accent}: text on light page`);
    assert.ok(contrastRatio(v.textOnLight, v.softLight) >= AA_CONTRAST, `${accent}: text on light wash`);
    assert.ok(contrastRatio(v.textOnDark, DARK_BACKGROUND) >= AA_CONTRAST, `${accent}: text on dark page`);
    assert.ok(contrastRatio(v.textOnDark, v.softDark) >= AA_CONTRAST, `${accent}: text on dark wash`);
    // Black or white, the better of the two: never under sqrt(21) ≈ 4.58 for any colour.
    assert.ok(contrastRatio(v.onAccent, v.accent) >= AA_CONTRAST, `${accent}: label on solid accent`);
  }
});

test("a colour that already reads is kept as it is; one that doesn't keeps its hue", () => {
  // A deep blue is fine on light, too dark for dark.
  const blue = accentVariants("#1d4ed8");
  assert.ok(blue);
  assert.equal(blue.textOnLight, "#1d4ed8");
  assert.notEqual(blue.textOnDark, "#1d4ed8");
  // Yellow is unreadable on white: darkened, still yellowish (red and green well above blue).
  const yellow = accentVariants("#ffee00");
  assert.ok(yellow);
  assert.notEqual(yellow.textOnLight, "#ffee00");
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(yellow.textOnLight.slice(i, i + 2), 16));
  assert.ok(r > b && g > b);
});

test("every value handed out is a plain #rrggbb, whatever went in", () => {
  const hex = /^#[0-9a-f]{6}$/;
  for (const accent of SAMPLES) {
    const v = accentVariants(accent);
    assert.ok(v);
    for (const value of Object.values(v)) assert.match(value, hex);
    for (const value of Object.values(accentStyle(accent) ?? {})) assert.match(value, hex);
  }
  assert.deepEqual(Object.keys(accentStyle("#336699") ?? {}).filter((key) => !key.startsWith("--event-accent")), []);
});

test("custom backgrounds are honoured, bad ones fall back to the defaults", () => {
  const dim = accentVariants("#336699", { light: "#f0f0f0", dark: "#101010" });
  assert.ok(dim);
  assert.ok(contrastRatio(dim.textOnLight, "#f0f0f0") >= AA_CONTRAST);
  assert.ok(contrastRatio(dim.textOnDark, "#101010") >= AA_CONTRAST);
  assert.deepEqual(accentVariants("#336699", { light: "white", dark: "url(x)" }), accentVariants("#336699"));
});

// ── what the browser sends ──────────────────────────────────────────────────

function pixels(colors: [number, number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(colors.flat());
}

test("dominantColor picks the vivid colour, not the white margin or the black ink", () => {
  const white: [number, number, number, number] = [255, 255, 255, 255];
  const black: [number, number, number, number] = [0, 0, 0, 255];
  const red: [number, number, number, number] = [200, 30, 40, 255];
  const grid = [...Array(50).fill(white), ...Array(30).fill(black), ...Array(20).fill(red)];
  const color = dominantColor(pixels(grid));
  assert.ok(color);
  assert.equal(color, "#c81e28");
  assert.match(color, /^#[0-9a-f]{6}$/);
});

test("dominantColor gives nothing for black-and-white, flat gray or transparent pictures", () => {
  assert.equal(dominantColor(pixels([[255, 255, 255, 255], [0, 0, 0, 255], [128, 128, 128, 255]])), null);
  assert.equal(dominantColor(pixels([[200, 30, 40, 0], [200, 30, 40, 10]])), null, "transparent pixels don't count");
  assert.equal(dominantColor(new Uint8ClampedArray(0)), null);
});

test("dominantColor weighs vivid colours above a slightly bigger dull area", () => {
  const dull: [number, number, number, number] = [150, 140, 130, 255]; // saturation ~0.07: ignored outright
  const teal: [number, number, number, number] = [20, 160, 170, 255];
  assert.equal(dominantColor(pixels([...Array(10).fill(dull), ...Array(3).fill(teal)])), "#14a0aa");
});
