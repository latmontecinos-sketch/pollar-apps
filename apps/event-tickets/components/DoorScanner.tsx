"use client";

import { useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";
import { formatEventDateTime, formatTimestamp } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";

type CheckResult =
  | { result: "VALID"; doorCode: string }
  | { result: "USED"; usedAt?: string }
  | { result: "UNKNOWN" }
  | { error: string };

type Feedback = { kind: "VALID" | "USED" | "UNKNOWN" | "ERROR"; title: string; detail: string };

/** Scanned, not yet spent: the door decides whether this person goes in. */
type Review = { code: string; doorCode: string };

const FEEDBACK_STYLES: Record<Feedback["kind"], string> = {
  VALID: "border-success-border bg-success-light text-success",
  USED: "border-error-border bg-error-light text-error",
  UNKNOWN: "border-error-border bg-error-light text-error",
  ERROR: "border-warning-border bg-warning-light text-warning",
};

/** How long a result stays on screen before the door is "ready" for the next person. */
const FEEDBACK_MS = 4000;

type EventSummary = { name: string; datetimeUtc: string; place: string; paid: number; checkedIn: number };

/** Authenticated fetch for the door endpoints: the organizer's signed session or the staff link token. */
export type DoorFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The door check-in screen, shared by the organizer (their own session) and
 * staff (the event's door link). Two steps on purpose: scanning only
 * *reads* the ticket, and the person on the door confirms before it's
 * spent — so a stray scan from a pocket never burns someone's entry.
 */
export function DoorScanner({
  eventId,
  doorFetch,
  onDenied,
}: {
  eventId: string;
  doorFetch: DoorFetch;
  /** 401/403 from the door API: not the organizer, or a revoked staff link. */
  onDenied: (message: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const fetchRef = useRef(doorFetch);
  const deniedRef = useRef(onDenied);
  useEffect(() => {
    fetchRef.current = doorFetch;
    deniedRef.current = onDenied;
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const busyRef = useRef(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [approving, setApproving] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [event, setEvent] = useState<EventSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchRef.current(`/api/events/${eventId}/door`);
      if (cancelled) return;
      const data = (await res.json()) as EventSummary & { error?: string };
      if (res.status === 401 || res.status === 403) return deniedRef.current(data.error ?? "");
      if (res.ok) setEvent(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  function show(next: Feedback) {
    setFeedback(next);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(next.kind === "VALID" ? 120 : [200, 100, 200]);
    }
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
  }

  function clearReview() {
    setReview(null);
    busyRef.current = false;
  }

  /** Step 1: read the code without spending it. */
  async function check(code: string) {
    if (busyRef.current || review) return;
    busyRef.current = true;
    try {
      const res = await fetchRef.current(`/api/events/${eventId}/door/check`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as CheckResult;
      if (res.status === 401 || res.status === 403) {
        deniedRef.current("error" in data ? data.error : "");
        return;
      }
      if ("error" in data) {
        show({ kind: "ERROR", title: t.door.errorTitle, detail: data.error });
      } else if (data.result === "VALID") {
        // Stays on screen until someone decides; no auto-clear here.
        setReview({ code, doorCode: data.doorCode });
        if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(60);
        return;
      } else if (data.result === "USED") {
        show({
          kind: "USED",
          title: t.door.usedTitle,
          detail: data.usedAt
            ? t.door.usedDetail(formatTimestamp(data.usedAt, locale))
            : t.door.usedDetailNoTime,
        });
      } else {
        show({ kind: "UNKNOWN", title: t.door.unknownTitle, detail: t.door.unknownDetail });
      }
    } catch (err) {
      show({
        kind: "ERROR",
        title: t.door.offlineTitle,
        detail: err instanceof Error ? err.message : t.door.offlineDetail,
      });
    } finally {
      if (!review) {
        setTimeout(() => {
          busyRef.current = false;
        }, 1500);
      }
    }
  }

  /** Step 2: the door says yes — now the ticket is spent, atomically. */
  async function approve(code: string) {
    setApproving(true);
    try {
      const res = await fetchRef.current(`/api/events/${eventId}/door`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as
        | { result: "VALID"; checkedIn?: number }
        | { result: "USED"; usedAt?: string }
        | { result: "UNKNOWN" }
        | { error: string };
      if ("error" in data) {
        show({ kind: "ERROR", title: t.door.errorTitle, detail: data.error });
      } else if (data.result === "VALID") {
        if (typeof data.checkedIn === "number") {
          const checkedIn = data.checkedIn;
          setEvent((current) => (current ? { ...current, checkedIn } : current));
        }
        show({ kind: "VALID", title: t.checkin.approved, detail: t.checkin.approvedDetail });
      } else if (data.result === "USED") {
        // Someone else let them in between the scan and the tap.
        show({
          kind: "USED",
          title: t.door.usedTitle,
          detail: data.usedAt
            ? t.door.usedDetail(formatTimestamp(data.usedAt, locale))
            : t.door.usedDetailNoTime,
        });
      } else {
        show({ kind: "UNKNOWN", title: t.door.unknownTitle, detail: t.door.unknownDetail });
      }
    } catch {
      show({ kind: "ERROR", title: t.door.offlineTitle, detail: t.checkin.approveError });
    } finally {
      setApproving(false);
      clearReview();
    }
  }

  useEffect(() => {
    if (!videoRef.current) return;
    let cancelled = false;

    QrScanner.hasCamera().then((hasCamera) => {
      if (cancelled || !videoRef.current) return;
      if (!hasCamera) {
        setCameraError(t.door.noCamera);
        return;
      }
      const scanner = new QrScanner(videoRef.current, (result) => void check(result.data), {
        highlightScanRegion: true,
        highlightCodeOutline: true,
        preferredCamera: "environment",
      });
      scannerRef.current = scanner;
      scanner.start().catch(() => setCameraError(t.door.cameraDenied));
    });

    return () => {
      cancelled = true;
      scannerRef.current?.destroy();
      scannerRef.current = null;
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    if (!manualCode.trim()) return;
    setManualBusy(true);
    await check(manualCode.trim().toUpperCase());
    setManualCode("");
    setManualBusy(false);
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">{t.door.validatingFor}</p>
          <p className="truncate font-semibold">{event?.name ?? "…"}</p>
          {event && (
            <p className="truncate text-xs text-muted first-letter:uppercase">
              {formatEventDateTime(event.datetimeUtc, locale)}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-muted">{t.door.checkedIn}</p>
          <p className="font-mono text-lg font-semibold">
            {event ? `${event.checkedIn} / ${event.paid}` : "…"}
          </p>
        </div>
      </div>

      <div className="relative">
        <Card className="overflow-hidden p-0">
          <video ref={videoRef} className="aspect-square w-full bg-foreground object-cover" muted playsInline />
        </Card>

        {review && (
          <div className="pollar-rise absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-success-border bg-success-light p-6 text-center">
            <span className="pollar-pop flex h-16 w-16 items-center justify-center rounded-full bg-background text-success">
              <Icon name="check" size={36} strokeWidth={3} />
            </span>
            <p className="text-2xl font-extrabold tracking-tight text-success">{t.checkin.reviewTitle}</p>
            <p className="text-sm font-medium text-foreground">{t.checkin.reviewBody}</p>
            <p className="font-mono text-lg font-bold tracking-[0.2em] text-foreground">
              {review.doorCode}
            </p>
            <div className="mt-1 grid w-full max-w-xs grid-cols-2 gap-2">
              <Button variant="secondary" onClick={clearReview} disabled={approving}>
                {t.checkin.reject}
              </Button>
              <Button loading={approving} onClick={() => void approve(review.code)}>
                {t.checkin.approve}
              </Button>
            </div>
          </div>
        )}

        {!review && feedback && (
          <div
            role="status"
            aria-live="assertive"
            className={`absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 p-6 text-center ${FEEDBACK_STYLES[feedback.kind]}`}
          >
            <span className="pollar-pop flex h-20 w-20 items-center justify-center rounded-full bg-background">
              <Icon
                name={feedback.kind === "VALID" ? "check" : feedback.kind === "ERROR" ? "alert" : "x"}
                size={44}
                strokeWidth={3}
              />
            </span>
            <p className="text-3xl font-extrabold tracking-tight">{feedback.title}</p>
            <p className="max-w-xs text-sm font-medium text-foreground">{feedback.detail}</p>
            <button
              onClick={() => setFeedback(null)}
              className="mt-2 rounded-xl bg-background px-4 py-2 text-sm font-semibold text-foreground shadow-sm"
            >
              {t.door.next}
            </button>
          </div>
        )}
      </div>

      {cameraError ? (
        <p className="rounded-xl border border-warning-border bg-warning-light px-3 py-2 text-sm text-foreground">
          {cameraError}
        </p>
      ) : (
        <p className="text-center text-sm text-muted">{t.door.aim}</p>
      )}

      <Card>
        <form onSubmit={submitManual} className="flex items-end gap-2">
          <Input
            label={t.door.manualLabel}
            placeholder={t.door.manualPlaceholder}
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            autoCapitalize="characters"
            autoComplete="off"
            className="flex-1 font-mono uppercase"
          />
          <Button type="submit" loading={manualBusy} disabled={!manualCode.trim()}>
            {t.door.validate}
          </Button>
        </form>
      </Card>

      <p className="flex items-start gap-2 px-1 text-xs leading-5 text-muted">
        <Icon name="shield" size={15} className="mt-0.5 text-primary" />
        {t.door.footerNote}
      </p>
    </>
  );
}
