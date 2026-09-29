import test from "node:test";
import assert from "node:assert/strict";

import nodemailer from "nodemailer";

import { sendCapacityCodeEmail, sendTicketEmail } from "../lib/mail.ts";

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

const SMTP = { SMTP_HOST: "smtp.gmail.com", SMTP_USER: "organizer@gmail.com", SMTP_PASS: "app-password" };

function stubSmtp(t: test.TestContext, fail?: Error) {
  const sent: Record<string, unknown>[] = [];
  const configs: Record<string, unknown>[] = [];
  t.mock.method(nodemailer, "createTransport", (config: Record<string, unknown>) => {
    configs.push(config);
    return {
      sendMail: async (message: Record<string, unknown>) => {
        if (fail) throw fail;
        sent.push(message);
        return { messageId: "1" };
      },
    };
  });
  return { sent, configs };
}

test("with SMTP configured, mail goes out through it from the mailbox itself — not Resend", async (t) => {
  withEnv(t, { ...SMTP, SMTP_PORT: undefined, MAIL_FROM: undefined, RESEND_API_KEY: "re_test" });
  const resend = stubFetch(t, () => Response.json({ id: "never" }));
  const { sent, configs } = stubSmtp(t);

  assert.deepEqual(await sendTicketEmail(TICKET), { sent: true });
  assert.equal(resend.length, 0, "Resend is the fallback, not a second copy");
  assert.equal(sent[0].to, TICKET.to);
  assert.equal(sent[0].from, "Pollar Pass <organizer@gmail.com>");
  assert.equal(configs[0].port, 465);
  assert.equal(configs[0].secure, true);
});

test("an SMTP failure is reported, with addresses masked", async (t) => {
  withEnv(t, SMTP);
  stubSmtp(t, new Error("550 5.1.1 <buyer+alias@gmail.com>: Recipient address rejected"));

  const result = await sendTicketEmail(TICKET);

  assert.equal(result.sent, false);
  assert.match(result.error ?? "", /^SMTP: 550/);
  assert.doesNotMatch(result.error ?? "", /buyer+alias@gmail.com/);
});

test("half an SMTP setup falls back to Resend instead of failing every send", async (t) => {
  withEnv(t, { SMTP_HOST: "smtp.gmail.com", SMTP_USER: "organizer@gmail.com", SMTP_PASS: undefined, RESEND_API_KEY: "re_test" });
  const calls = stubFetch(t, () => Response.json({ id: "email_1" }));
  assert.deepEqual(await sendTicketEmail(TICKET), { sent: true });
  assert.equal(calls.length, 1);
});

test("the capacity code email carries the code, in the organizer's language", async (t) => {
  withEnv(t, SMTP);
  const { sent } = stubSmtp(t);
  const result = await sendCapacityCodeEmail({
    to: "organizer@gmail.com",
    locale: "en",
    eventName: "Noche de prueba",
    tierName: "VIP",
    capacity: 80,
    code: "042917",
  });
  assert.deepEqual(result, { sent: true });
  assert.match(String(sent[0].subject), /capacity/);
  assert.match(String(sent[0].text), /042917/);
  assert.match(String(sent[0].html), /042917/);
  assert.match(String(sent[0].text), /80 tickets/);
});
