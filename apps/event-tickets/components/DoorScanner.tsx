"use client";

import { useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";
import { formatEventDateTime, formatTimestamp } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";
import { DoorResult, doorButtonPrimary, doorButtonSecondary } from "@/components/DoorResult";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";

type CheckResult =
  | { result: "VALID"; doorCode: string }
  | { result: "USED"; usedAt?: string }
  | { result: "UNKNOWN" }
  | { error: string; code?: string };

type Feedback = { kind: "VALID" | "USED" | "UNKNOWN" | "ERROR"; title: string; detail: string };

/** Scanned, not yet spent: the door decides whether this person goes in. */
type Review = { code: string; doorCode: string };

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
  /** See setReviewNow: the scanner's callback can only trust a ref, not state. */
  const reviewRef = useRef<Review | null>(null);
  const [approving, setApproving] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [event, setEvent] = useState<EventSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchRef.current(`/api/events/${eventId}/door`);
      if (cancelled) return;
      const data = (await res.json()) as EventSummary & { error?: string; code?: string };
      if (res.status === 401 || res.status === 403) {
        return deniedRef.current(apiErrorMessage(t, data, data.error ?? ""));
      }
      if (res.ok) setEvent(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, t]);

  function show(next: Feedback) {
    setFeedback(next);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(next.kind === "VALID" ? 120 : [200, 100, 200]);
    }
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
  }

  /**
   * Both the ref and the state, always together.
   *
   * `check` runs inside the QrScanner callback, which is created once and
   * therefore closes over the first render's `review` forever — so the guard
   * that is supposed to hold the camera while someone decides was reading a
   * value frozen at `null`. A ref fixes the staleness, but only if it's
   * written synchronously: `setReview` followed by the `finally` block would
   * still see the old ref, because React hasn't re-rendered yet. The ref is
   * the authority for the guard; the state only drives the render.
   */
  function setReviewNow(next: Review | null) {
    reviewRef.current = next;
    setReview(next);
  }

  function clearReview() {
    setReviewNow(null);
    busyRef.current = false;
  }

  /** Step 1: read the code without spending it. */
  async function check(code: string) {
    if (busyRef.current || reviewRef.current) return;
    busyRef.current = true;
    try {
      const res = await fetchRef.current(`/api/events/${eventId}/door/check`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as CheckResult;
      if (res.status === 401 || res.status === 403) {
        deniedRef.current("error" in data ? apiErrorMessage(t, data, data.error) : "");
        return;
      }
      if ("error" in data) {
        show({ kind: "ERROR", title: t.door.errorTitle, detail: apiErrorMessage(t, data, data.error) });
      } else if (data.result === "VALID") {
        // Stays on screen until someone decides; no auto-clear here.
        setReviewNow({ code, doorCode: data.doorCode });
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
      // The ref, not the state: at this point `setReviewNow` has run but React
      // has not re-rendered, so `review` would still read as null and release
      // the camera 1.5s later with a decision still pending on screen.
      if (!reviewRef.current) {
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
        | { result: "VALID"; checkedIn?: number; notified?: "none" | "sent" | "failed" }
        | { result: "USED"; usedAt?: string }
        | { result: "UNKNOWN" }
        | { error: string; code?: string };
      if ("error" in data) {
        show({ kind: "ERROR", title: t.door.errorTitle, detail: apiErrorMessage(t, data, data.error) });
      } else if (data.result === "VALID") {
        if (typeof data.checkedIn === "number") {
          const checkedIn = data.checkedIn;
          setEvent((current) => (current ? { ...current, checkedIn } : current));
        }
        // Rule 14: the email is best-effort, so the screen says when it did not go.
        show({
          kind: "VALID",
          title: t.checkin.approved,
          detail:
            data.notified === "failed"
              ? `${t.checkin.approvedDetail} ${t.checkin.notifyFailed}`
              : t.checkin.approvedDetail,
        });
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
      <div className="flex items-center justify-between gap-3 rounded-3xl bg-background px-5 py-4 shadow-sm ring-1 ring-foreground/10">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted">{t.door.validatingFor}</p>
          <p className="truncate text-lg font-bold">{event?.name ?? "…"}</p>
          {event && (
            <p className="truncate text-xs text-muted first-letter:uppercase">
              {formatEventDateTime(event.datetimeUtc, locale)}
            </p>
          )}
        </div>
        <div className="shrink-0 rounded-2xl bg-primary-light px-4 py-2 text-right">
          <p className="text-xs font-medium text-muted">{t.door.checkedIn}</p>
          <p className="font-mono text-3xl font-extrabold leading-tight tabular-nums text-primary-text">
            {event ? `${event.checkedIn}/${event.paid}` : "…"}
          </p>
        </div>
      </div>

      <div className="relative">
        {/* Portrait on a phone, so the result that covers it has room for a big title, the code and two big buttons. */}
        <div className="overflow-hidden rounded-3xl bg-foreground shadow-sm">
          <video ref={videoRef} className="aspect-[3/4] w-full object-cover sm:aspect-square" muted playsInline />
        </div>

        {review && (
          <DoorResult kind="REVIEW" title={t.checkin.reviewTitle} detail={t.checkin.reviewBody} doorCode={review.doorCode}>
            <button type="button" onClick={() => void approve(review.code)} disabled={approving} className={doorButtonPrimary}>
              {approving && <Spinner size={22} className="mr-2" />}
              {t.checkin.approve}
            </button>
            <button type="button" onClick={clearReview} disabled={approving} className={doorButtonSecondary}>
              {t.checkin.reject}
            </button>
          </DoorResult>
        )}

        {!review && feedback && (
          <DoorResult kind={feedback.kind} title={feedback.title} detail={feedback.detail}>
            <button type="button" onClick={() => setFeedback(null)} className={doorButtonPrimary}>
              {t.door.next}
            </button>
          </DoorResult>
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
