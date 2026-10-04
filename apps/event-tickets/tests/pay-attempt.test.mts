/**
 * The release rule: when an attempt that left no trace may be written off.
 * A wrong "yes" here is a second payment, so every edge has a case.
 *
 * Pure: a clock is a number, a sale is an object.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ATTEMPT_SLACK_MS,
  ATTEMPT_TX_TIMEOUT_SEC,
  attemptDeadlineMs,
  attemptState,
  mayStartOver,
  pendingSaleIsDead,
} from "../lib/pay-attempt.ts";

const T0 = Date.parse("2026-10-03T12:00:00.000Z");
const STARTED = new Date(T0).toISOString();
const DEADLINE = T0 + ATTEMPT_TX_TIMEOUT_SEC * 1000 + ATTEMPT_SLACK_MS;

test("the deadline is the transaction's lifetime plus the slack", () => {
  assert.equal(attemptDeadlineMs(T0), DEADLINE);
  assert.ok(DEADLINE > T0 + ATTEMPT_TX_TIMEOUT_SEC * 1000, "never earlier than the transaction can still land");
});

test("an attempt is in flight until its transaction can no longer land", () => {
  assert.equal(attemptState(null, T0), "none");
  assert.equal(attemptState(undefined, T0), "none");
  assert.equal(attemptState(STARTED, T0), "in_flight");
  assert.equal(attemptState(STARTED, T0 + 60_000), "in_flight");
  assert.equal(attemptState(STARTED, DEADLINE), "in_flight", "the boundary itself still counts as alive");
  assert.equal(attemptState(STARTED, DEADLINE + 1), "dead");
});

test("a start time that cannot be read is never written off", () => {
  assert.equal(attemptState("not a date", T0 + 24 * 60 * 60_000), "in_flight");
});

const sale = (over: Partial<{ status: string; payStartedAt: string | null; expiresAtUtc: string }> = {}) => ({
  status: "pending",
  payStartedAt: null as string | null,
  expiresAtUtc: new Date(T0 + 10 * 60_000).toISOString(),
  ...over,
});

test("a pending sale nobody started is dead only after its hold", () => {
  assert.equal(pendingSaleIsDead(sale(), T0 + 9 * 60_000), false);
  assert.equal(pendingSaleIsDead(sale(), T0 + 10 * 60_000 + 1), true);
});

test("a pending sale whose attempt started lives by the attempt, not by the hold", () => {
  // The hold would end at T0+10min, but a payment started at T0+9min can land until much later.
  const started = new Date(T0 + 9 * 60_000).toISOString();
  const s = sale({ payStartedAt: started });
  assert.equal(pendingSaleIsDead(s, T0 + 10 * 60_000 + 1), false);
  assert.equal(pendingSaleIsDead(s, attemptDeadlineMs(T0 + 9 * 60_000) + 1), true);
});

test("a started attempt can be dead before the hold ends", () => {
  const s = sale({ payStartedAt: STARTED, expiresAtUtc: new Date(T0 + 30 * 60_000).toISOString() });
  assert.equal(pendingSaleIsDead(s, DEADLINE + 1), true);
});

test("only a pending sale can be dead", () => {
  for (const status of ["paid", "unclaimed", "refunded", "expired"]) {
    assert.equal(pendingSaleIsDead(sale({ status, payStartedAt: STARTED }), DEADLINE + 1), false, status);
  }
});

test("starting over is allowed only when the sale is over and no attempt is alive", () => {
  // Over, never started: the old client-side "forget after the hold" case, now the server's call.
  assert.equal(mayStartOver(sale({ status: "expired" }), T0), true);
  // Over, started, and the transaction is dead.
  assert.equal(mayStartOver(sale({ status: "expired", payStartedAt: STARTED }), DEADLINE + 1), true);
  // Pending but dead: the caller expires it, and this already says yes.
  assert.equal(mayStartOver(sale({ payStartedAt: STARTED }), DEADLINE + 1), true);
});

test("starting over is refused while an attempt may still land", () => {
  // Released after a rejection proven in the sender's tab, seen from another tab: waits for the deadline.
  assert.equal(mayStartOver(sale({ status: "expired", payStartedAt: STARTED }), T0 + 60_000), false);
  // Still pending and started.
  assert.equal(mayStartOver(sale({ payStartedAt: STARTED }), T0 + 60_000), false);
  // Still pending, never started, hold not over.
  assert.equal(mayStartOver(sale(), T0 + 60_000), false);
});

test("a sale with a payment behind it is never started over", () => {
  for (const status of ["paid", "unclaimed", "refunded"]) {
    assert.equal(mayStartOver(sale({ status }), DEADLINE + 1), false, status);
  }
});
