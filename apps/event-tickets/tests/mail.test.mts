import test from "node:test";
import assert from "node:assert/strict";

import { sendTicketEmail } from "../lib/mail.ts";

/**
 * The ticket email is best-effort, so its failures are silent by design —
 * which is exactly how production spent days answering every buyer but the
 * Resend account owner with a 403 nobody could diagnose. These pin down the
 * two things that made it invisible: the log said only "403", and the buyer
 * was told the email went out regardless (see `emailed` in the confirm route).
 *
 * Resend is stubbed: no test here sends mail.
 */

const TICKET = {
  to: "buyer+alias@gmail.com",
  locale: "es" as const,
  origin: "https://pollarpass.example",
  eventName: "Noche de prueba",
  eventDateTime: "2030-01-01T23:00:00.000Z",
  eventPlace: "La Paz",
  ticketCode: "code-123",
  doorCode: "AB12CD",
};

type Captured = { url: string; body: Record<string, unknown> };

function stubFetch(t: test.TestContext, respond: () => Response): Captured[] {
  const calls: Captured[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return respond();
  });
  return calls;
}

function withEnv(t: test.TestContext, vars: Record<string, string | undefined>) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("a testing-domain 403 says why in the log, with every address masked", async (t) => {
  withEnv(t, { RESEND_API_KEY: "re_test", MAIL_FROM: undefined });
  stubFetch(t, () =>
    Response.json(
      {
        statusCode: 403,
        name: "validation_error",
        message:
          "You can only send testing emails to your own email address (owner@gmail.com). To send emails to other recipients, please verify a domain.",
      },
      { status: 403 }
    )
  );

  const result = await sendTicketEmail(TICKET);

  assert.equal(result.sent, false);
  assert.match(result.error ?? "", /403/);
  assert.match(result.error ?? "", /validation_error/);
  assert.match(result.error ?? "", /verify a domain/);
  assert.match(result.error ?? "", /o…@gmail\.com/);
  assert.doesNotMatch(result.error ?? "", /owner@gmail\.com/);
});

test("a failure with no JSON body still reports the status", async (t) => {
  withEnv(t, { RESEND_API_KEY: "re_test" });
  stubFetch(t, () => new Response("upstream down", { status: 502 }));

  const result = await sendTicketEmail(TICKET);

  assert.deepEqual(result, { sent: false, error: "Resend respondió 502" });
});

test("sends from MAIL_FROM when set, and from the testing sender when not", async (t) => {
  withEnv(t, { RESEND_API_KEY: "re_test", MAIL_FROM: "Pollar Pass <tickets@pollarpass.example>" });
  const calls = stubFetch(t, () => Response.json({ id: "email_1" }));

  assert.deepEqual(await sendTicketEmail(TICKET), { sent: true });
  assert.equal(calls[0].body.from, "Pollar Pass <tickets@pollarpass.example>");
  assert.deepEqual(calls[0].body.to, [TICKET.to]);

  process.env.MAIL_FROM = "   ";
  await sendTicketEmail(TICKET);
  assert.equal(calls[1].body.from, "Pollar Pass <onboarding@resend.dev>");
});

test("no API key: nothing is sent and nothing claims it was", async (t) => {
  withEnv(t, { RESEND_API_KEY: undefined });
  const calls = stubFetch(t, () => Response.json({ id: "never" }));

  const result = await sendTicketEmail(TICKET);

  assert.equal(result.sent, false);
  assert.equal(calls.length, 0);
});
