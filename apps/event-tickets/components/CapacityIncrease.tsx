"use client";

import { useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { useLocale, useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";

type Step =
  | { step: "ask" }
  | { step: "code"; challengeId: string; capacity: number; sentTo: string }
  | { step: "done"; capacity: number };

/**
 * Raising one tier's capacity, in two steps: the new total → a code by
 * email → the code back. The server binds the code to this exact change
 * (lib/capacity-code.ts), so the number can't be edited between the steps;
 * changing it means asking for a new code.
 */
export function CapacityIncrease({
  eventId,
  ticketTypeId,
  currentCapacity,
  onRaised,
}: {
  eventId: string;
  ticketTypeId: string;
  currentCapacity: number;
  /** The event as the PATCH returns it, so the panel's numbers update at once. */
  onRaised: (event: unknown) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { user } = usePollarAuth();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });

  const profileEmail = user?.profile?.mail ?? "";
  const [state, setState] = useState<Step>({ step: "ask" });
  const [wanted, setWanted] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, method: string, body: unknown) {
    const res = await pollarFetch(pollarRef.current.getClient(), user!.address, path, {
      method,
      body: JSON.stringify(body),
    });
    return { res, data: (await res.json()) as Record<string, unknown> & { error?: string; code?: string } };
  }

  async function sendCode(capacity: number) {
    setError(null);
    if (!Number.isInteger(capacity) || capacity <= currentCapacity) return setError(t.capacity.errorLower);
    setBusy(true);
    try {
      const { res, data } = await call(`/api/events/${eventId}/capacity-code`, "POST", {
        ticketTypeId,
        capacity,
        // The server only uses this until an inbox is confirmed for this organizer.
        email: profileEmail || email.trim(),
        locale,
      });
      if (!res.ok) return setError(apiErrorMessage(t, data, t.panel.saveError));
      setCode("");
      setState({ step: "code", challengeId: String(data.challengeId), capacity, sentTo: String(data.sentTo) });
    } catch {
      setError(t.panel.saveError);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (state.step !== "code") return;
    setError(null);
    setBusy(true);
    try {
      const { res, data } = await call(`/api/events/${eventId}`, "PATCH", {
        ticketTypeId,
        capacity: state.capacity,
        challengeId: state.challengeId,
        code: code.replace(/\s+/g, ""),
      });
      if (!res.ok) return setError(apiErrorMessage(t, data, t.panel.saveError));
      setState({ step: "done", capacity: state.capacity });
      setWanted("");
      onRaised(data);
    } catch {
      setError(t.panel.saveError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {state.step === "code" ? (
        <>
          <p className="text-xs leading-5 text-muted">{t.capacity.codeSent(state.sentTo, state.capacity)}</p>
          <div className="flex items-end gap-2">
            <Input
              label={t.capacity.codeField}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="flex-1 font-mono tracking-[0.3em]"
            />
            <Button loading={busy} disabled={code.replace(/\D/g, "").length !== 6} onClick={() => void confirm()}>
              {t.capacity.confirm}
            </Button>
          </div>
          <div className="flex gap-4 text-xs font-semibold">
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendCode(state.capacity)}
              className="text-primary-text underline disabled:opacity-50"
            >
              {t.capacity.resend}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setState({ step: "ask" });
              }}
              className="text-muted underline disabled:opacity-50"
            >
              {t.common.cancel}
            </button>
          </div>
        </>
      ) : (
        <>
          {state.step === "done" && (
            <p className="rounded-xl border border-success-border bg-success-light px-3 py-2 text-xs font-semibold text-success">
              {t.capacity.done(state.capacity)}
            </p>
          )}
          <p className="text-xs leading-5 text-muted">{t.capacity.body}</p>
          {!profileEmail && (
            <Input
              label={t.capacity.emailField}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
          {!profileEmail && <p className="-mt-1 text-xs leading-5 text-muted">{t.capacity.emailHint}</p>}
          <div className="flex items-end gap-2">
            <Input
              label={t.capacity.field}
              type="number"
              inputMode="numeric"
              min={currentCapacity + 1}
              placeholder={String(currentCapacity + 10)}
              value={wanted}
              onChange={(e) => setWanted(e.target.value)}
              className="flex-1"
            />
            <Button loading={busy} disabled={!wanted.trim()} onClick={() => void sendCode(Number(wanted))}>
              {t.capacity.submit}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
