"use client";

import { use, useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { formatTimestamp } from "@/lib/format";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";

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

type EventSummary = { name: string; paid: number; checkedIn: number };

/**
 * Door mode: organizer-only, in their own session (no third-party delegation
 * — see the design's known limitation). Camera scan or typed short code both
 * hit the same atomic endpoint; the response is only VALID/USED/UNKNOWN.
 * Results are big, colored, vibrate, and clear themselves, so a stale
 * "válida" never gets read as the next person's result.
 */
export default function DoorModePage({
  params,
}: PageProps<"/organizador/eventos/[id]/puerta">) {
  const { id } = use(params);
  const { user, isLoading: authLoading } = usePollarAuth();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
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
  const [forbidden, setForbidden] = useState(false);

  const address = user?.address;

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      const res = await pollarFetch(pollarRef.current.getClient(), address, `/api/events/${id}`);
      if (cancelled) return;
      if (res.status === 403 || res.status === 401) return setForbidden(true);
      if (res.ok) setEvent((await res.json()) as EventSummary);
    })();
    return () => {
      cancelled = true;
    };
  }, [address, id]);

  function show(next: Feedback) {
    setFeedback(next);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(next.kind === "VALID" ? 120 : [200, 100, 200]);
    }
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
  }

  async function validate(code: string) {
    if (!address || busyRef.current) return;
    busyRef.current = true;
    try {
      const client = pollarRef.current.getClient();
      const res = await pollarFetch(client, address, `/api/events/${id}/door`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as DoorResult;
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
            ? `Esta entrada ingresó el ${formatTimestamp(data.usedAt)}. No dejes pasar.`
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
    if (!address || forbidden || !videoRef.current) return;
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, id, forbidden]);

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    []
  );

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    if (!manualCode.trim()) return;
    setManualBusy(true);
    await validate(manualCode.trim().toUpperCase());
    setManualCode("");
    setManualBusy(false);
  }

  if (authLoading) return null;

  const back = { href: `/organizador/eventos/${id}`, label: "Panel del evento" };

  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <AppHeader title="Modo puerta" back={back} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PollarLogo size={64} />
          <p className="max-w-sm text-muted">Ingresa con la cuenta que creó el evento para validar entradas.</p>
          <LoginButton />
        </div>
      </main>
    );
  }

  if (forbidden) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <AppHeader title="Modo puerta" back={back} />
        <Card className="flex flex-col gap-2 text-center">
          <p className="font-semibold text-error">Este evento no es tuyo</p>
          <p className="text-sm text-muted">Solo la cuenta que creó el evento puede validar entradas.</p>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title="Modo puerta" back={back} />

      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">Validando para</p>
          <p className="truncate font-semibold">{event?.name ?? "…"}</p>
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
    </main>
  );
}
