/** The showcase chips' links (lib/showcase-filters.ts `showcaseHref`): pure, so no database. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseShowcaseFilters, showcaseHref } from "../lib/showcase-filters.ts";

const none = { city: null, when: "all" } as const;

test("the unfiltered page has no query string", () => {
  assert.equal(showcaseHref(none, {}), "/app");
  assert.equal(showcaseHref({ city: "La Paz", when: "week" }, { city: null, when: "all" }), "/app");
});

test("a chip changes one filter and keeps the other", () => {
  assert.equal(showcaseHref(none, { city: "La Paz" }), "/app?city=La+Paz");
  assert.equal(showcaseHref({ city: "La Paz", when: "all" }, { when: "today" }), "/app?city=La+Paz&when=today");
  assert.equal(showcaseHref({ city: "La Paz", when: "today" }, { city: null }), "/app?when=today");
});

test("a city is encoded, so it cannot add parameters or break out of the link", () => {
  const href = showcaseHref(none, { city: "A&when=today#x" });
  assert.equal(href, "/app?city=A%26when%3Dtoday%23x");
  assert.deepEqual(parseShowcaseFilters(Object.fromEntries(new URL(href, "http://x").searchParams)), {
    city: "A&when=today#x",
    when: "all",
  });
});

test("a link built from filters parses back to the same filters", () => {
  for (const when of ["all", "today", "week"] as const) {
    for (const city of [null, "Santa Cruz", "Potosí"]) {
      const href = showcaseHref(none, { city, when });
      const params = Object.fromEntries(new URL(href, "http://x").searchParams);
      assert.deepEqual(parseShowcaseFilters(params), { city, when });
    }
  }
});
