/**
 * `APP_ORIGIN` is a list. These pin down what each reader of it does with
 * several entries: the sign-in audience takes all of them, and the email
 * takes the first, as a clean URL (a comma-joined value used to land inside
 * the QR link and break it).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { acceptedHosts, configuredOrigins, publicOrigin, requestHost, requestOrigin } from "../lib/app-origin.ts";
import { appOrigin } from "../lib/mail.ts";

afterEach(() => {
  delete process.env.APP_ORIGIN;
});

const request = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

test("the list is split, trimmed, normalised and de-duplicated", () => {
  assert.deepEqual(
    configuredOrigins("https://pollarpass.example/, pass.example ,https://pollarpass.example, http://localhost:3000/x"),
    ["https://pollarpass.example", "https://pass.example", "http://localhost:3000"]
  );
  assert.deepEqual(configuredOrigins(""), []);
  assert.deepEqual(configuredOrigins(undefined), []);
  assert.deepEqual(configuredOrigins("ftp://nope.example"), []);
});

test("the email links to the FIRST configured origin, never a comma-joined list", () => {
  process.env.APP_ORIGIN = "https://pollarpass.example, https://other.example";
  const origin = appOrigin(request("http://internal:3000/api/sales/x/confirm"));
  assert.equal(origin, "https://pollarpass.example");
  assert.ok(!origin.includes(","));
  assert.equal(
    `${origin}/api/tickets/${encodeURIComponent("code-1")}/qr`,
    "https://pollarpass.example/api/tickets/code-1/qr"
  );
});

test("a trailing slash or a bare host in APP_ORIGIN still gives a plain origin", () => {
  process.env.APP_ORIGIN = "pollarpass.example/";
  assert.equal(appOrigin(request("http://internal:3000/")), "https://pollarpass.example");
});

test("a request's Host header does not move the email's link when APP_ORIGIN is set", () => {
  process.env.APP_ORIGIN = "https://pollarpass.example";
  const forged = request("https://evil.example/api/sales", { host: "evil.example", "x-forwarded-host": "evil.example" });
  assert.equal(appOrigin(forged), "https://pollarpass.example");
  assert.deepEqual(acceptedHosts(forged), ["pollarpass.example"]);
});

test("with no APP_ORIGIN, the email and the audience follow where the request arrived", () => {
  const plain = request("http://localhost:3000/api/sales");
  assert.equal(appOrigin(plain), "http://localhost:3000");
  assert.deepEqual(acceptedHosts(plain), ["localhost:3000"]);

  // Behind a proxy (Vercel): public host and scheme from the forwarded headers.
  const proxied = request("http://internal:3000/api/sales", {
    "x-forwarded-host": "Pollarpass.Vercel.app",
    "x-forwarded-proto": "https",
  });
  assert.equal(requestHost(proxied), "pollarpass.vercel.app");
  assert.equal(requestOrigin(proxied), "https://pollarpass.vercel.app");
  assert.equal(publicOrigin(proxied), "https://pollarpass.vercel.app");
  assert.deepEqual(acceptedHosts(proxied), ["pollarpass.vercel.app"]);
});

test("a forwarded scheme that is not http(s) is ignored", () => {
  const odd = request("http://internal:3000/", { "x-forwarded-host": "a.example", "x-forwarded-proto": "javascript" });
  assert.equal(requestOrigin(odd), "http://a.example");
});
