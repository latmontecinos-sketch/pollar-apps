"use client";

import { useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";
import { formatEventDateTime, formatTimestamp } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";

type DoorResult =
  | { result: "VALID"; checkedIn?: number }
  | { result: "USED"; usedAt?: string }
  | { result: "UNKNOWN" }
  | { error: string };

type Feedback = { kind: "VALID" | "USED" | "UNKNOWN" | "ERROR"; title: string; detail: string };

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
 * staff (the event's door link). Camera scan or typed short code both hit
 * the same atomic endpoint; the response is only VALID/USED/UNKNOWN.
 * Results are big, colored, vibrate, and clear themselves, so a stale
 * "válida" never gets read as the next person's result.
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
  const [manualCode, setManualCode] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [event, setEvent] = useState<EventSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchRef.current(`/api/events/${eventId}/door`);
      if (cancelled) return;
      const data = (await res.json()) as EventSummary & { error?: string };
      if (res.status === 401 || res.status === 403) return deniedRef.current(data.error ?? "Sin acceso");
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

  async function validate(code: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const res = await fetchRef.current(`/api/events/${eventId}/door`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as DoorResult;
      if (res.status === 401 || res.status === 403) {
        deniedRef.current("error" in data ? data.error : "Sin acceso");
        return;
      }
      if ("error" in data) {
        show({ kind: "ERROR", title: "No se pudo validar", detail: data.error });
      } else if (data.result === "VALID") {
        if (typeof data.checkedIn === "number") {
          const checkedIn = data.checkedIn;
          setEvent((current) => (current ? { ...current, checkedIn } : current));
        }
        show({ kind: "VALID", title: "Entrada válida", detail: "Puede pasar." });
      } else if (data.result === "USED") {
        show({
          kind: "USED",
          title: "Ya fue usada",
          detail: data.usedAt
            ? `Ingresó el ${formatTimestamp(data.usedAt)} — no dejes pasar.`
            : "Esta entrada ya ingresó. No dejes pasar.",
        });
      } else {
        show({
          kind: "UNKNOWN",
          title: "No válida",
          detail: "Este código no corresponde a ninguna entrada de este evento.",
        });
      }
    } catch (err) {
      show({
        kind: "ERROR",
        title: "Sin conexión",
        detail: err instanceof Error ? err.message : "Revisa tu internet e intenta de nuevo.",
      });
    } finally {
      // Brief cooldown so the same QR held in front of the camera isn't re-sent.
      setTimeout(() => {
        busyRef.current = false;
      }, 2000);
    }
  }

  useEffect(() => {
    if (!videoRef.current) return;
    let cancelled = false;

    QrScanner.hasCamera().then((hasCamera) => {
      if (cancelled || !videoRef.current) return;
      if (!hasCamera) {
        setCameraError("No encontramos una cámara. Usa el código de puerta de abajo.");
        return;
      }
      const scanner = new QrScanner(videoRef.current, (result) => void validate(result.data), {
        highlightScanRegion: true,
        highlightCodeOutline: true,
        preferredCamera: "environment",
      });
      scannerRef.current = scanner;
      scanner.start().catch(() => {
        setCameraError(
          "No pudimos abrir la cámara. Permite el acceso a la cámara en tu navegador, o usa el código de puerta."
        );
      });
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
    await validate(manualCode.trim().toUpperCase());
    setManualCode("");
    setManualBusy(false);
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">Validando para</p>
          <p className="truncate font-semibold">{event?.name ?? "…"}</p>
          {event && (
            <p className="truncate text-xs text-muted first-letter:uppercase">
              {formatEventDateTime(event.datetimeUtc)}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-muted">Ingresaron</p>
          <p className="font-mono text-lg font-semibold">
            {event ? `${event.checkedIn} / ${event.paid}` : "…"}
          </p>
        </div>
      </div>

      <div className="relative">
        <Card className="overflow-hidden p-0">
          <video ref={videoRef} className="aspect-square w-full bg-foreground object-cover" muted playsInline />
        </Card>
        {feedback && (
          <div
            role="status"
            aria-live="assertive"
            className={`absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 p-6 text-center ${FEEDBACK_STYLES[feedback.kind]}`}
          >
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-background">
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
              Siguiente
            </button>
          </div>
        )}
      </div>

      {cameraError ? (
        <p className="rounded-xl border border-warning-border bg-warning-light px-3 py-2 text-sm text-foreground">
          {cameraError}
        </p>
      ) : (
        <p className="text-center text-sm text-muted">
          Apunta la cámara al QR de la entrada. El resultado aparece solo.
        </p>
      )}

      <Card>
        <form onSubmit={submitManual} className="flex items-end gap-2">
          <Input
            label="¿No se puede escanear? Escribe el código de puerta"
            placeholder="Ej: UJE4YMVP"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            autoCapitalize="characters"
            autoComplete="off"
            className="flex-1 font-mono uppercase"
          />
          <Button type="submit" loading={manualBusy} disabled={!manualCode.trim()}>
            Validar
          </Button>
        </form>
      </Card>

      <p className="flex items-start gap-2 px-1 text-xs leading-5 text-muted">
        <Icon name="shield" size={15} className="mt-0.5 text-primary" />
        Cada entrada vale una sola vez: se marca como usada en el mismo instante en que se valida,
        así que una captura de pantalla de un QR ya usado sale en rojo.
      </p>
    </>
  );
}
