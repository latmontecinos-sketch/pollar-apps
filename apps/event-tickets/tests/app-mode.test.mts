import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_MODE_COOKIE, modeCookie, modeForPath, modeFromCookies } from "../lib/app-mode.ts";

test("the stored mode is read back from a cookie string, and junk reads as no choice", () => {
  assert.equal(modeFromCookies(`theme=dark; ${APP_MODE_COOKIE}=organize; locale=es`), "organize");
  assert.equal(modeFromCookies(`${APP_MODE_COOKIE}=explore`), "explore");
  assert.equal(modeFromCookies("theme=dark"), null);
  assert.equal(modeFromCookies(""), null);
  assert.equal(modeFromCookies(`${APP_MODE_COOKIE}=admin`), null);
  assert.equal(modeFromCookies(`x${APP_MODE_COOKIE}=organize`), null);
});

test("the cookie a mode is stored in round-trips, and is Secure only over https", () => {
  const cookie = modeCookie("organize", true);
  assert.equal(modeFromCookies(cookie.split(";")[0]), "organize");
  assert.match(cookie, /; Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/);
  assert.doesNotMatch(modeCookie("explore", false), /Secure/);
});

test("organizer screens put the app in organizer mode; shared screens don't pick a side", () => {
  assert.equal(modeForPath("/mis-eventos"), "organize");
  assert.equal(modeForPath("/organizador/nuevo"), "organize");
  assert.equal(modeForPath("/organizador/eventos/abc"), "organize");
  assert.equal(modeForPath("/escanear"), "organize");
  assert.equal(modeForPath("/puerta/abc"), null);
  assert.equal(modeForPath("/mis-pases"), "explore");
  assert.equal(modeForPath("/app"), null);
  assert.equal(modeForPath("/e/abc"), null);
  assert.equal(modeForPath("/mis-eventosx"), null);
});
