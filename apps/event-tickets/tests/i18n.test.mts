/**
 * Every language has to answer for every string. TypeScript already forces
 * the shape; this catches the other half — a key left in Spanish inside
 * `en.ts`, or a translation that dropped an interpolated value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DICTIONARIES, LOCALES } from "../lib/i18n/index.ts";

type Node = Record<string, unknown>;

function paths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => paths(item, `${prefix}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Node).flatMap(([key, child]) =>
      paths(child, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [prefix];
}

test("all three languages define exactly the same keys", () => {
  const spanish = paths(DICTIONARIES.es).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(paths(DICTIONARIES[locale]).sort(), spanish, `${locale} differs from es`);
  }
});

test("no empty strings", () => {
  for (const locale of LOCALES) {
    const walk = (value: unknown, path: string) => {
      if (typeof value === "string") {
        assert.ok(value.trim().length > 0, `${locale}: ${path} is empty`);
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}[${index}]`));
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Node)) walk(child, `${path}.${key}`);
      }
    };
    walk(DICTIONARIES[locale], locale);
  }
});

test("interpolated strings keep their values in every language", () => {
  const samples: [string, (d: (typeof DICTIONARIES)["es"]) => string, string[]][] = [
    ["event.remaining", (d) => d.event.remaining(3, 40), ["3", "40"]],
    ["buy.cta", (d) => d.buy.cta("2,50"), ["2,50"]],
    ["buy.missing", (d) => d.buy.missing("2,50", "0,00"), ["2,50", "0,00"]],
    ["myEvents.sold", (d) => d.myEvents.sold(2, 5), ["2", "5"]],
    ["tickets.usedAt", (d) => d.tickets.usedAt("19 sept"), ["19 sept"]],
    ["hold.countdown", (d) => d.hold.countdown("9:31"), ["9:31"]],
    ["notifications.sold", (d) => d.notifications.sold("Jazz"), ["Jazz"]],
    ["email.subject", (d) => d.email.subject("Jazz"), ["Jazz"]],
    ["staff.message", (d) => d.staff.message("Jazz", "https://x/y"), ["Jazz", "https://x/y"]],
  ];
  for (const locale of LOCALES) {
    for (const [name, render, expected] of samples) {
      const text = render(DICTIONARIES[locale]);
      for (const value of expected) {
        assert.ok(text.includes(value), `${locale}: ${name} dropped "${value}" — got "${text}"`);
      }
    }
  }
});

test("the untranslatable bits stay put", () => {
  for (const locale of LOCALES) {
    const dict = DICTIONARIES[locale];
    assert.equal(dict.common.appName, "Pollar Pass");
    assert.equal(dict.hold.minutes, 10, "the countdown copy must match SALE_TTL_MS");
  }
});
