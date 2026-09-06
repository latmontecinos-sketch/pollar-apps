"use client";

import { use, useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";

type DoorResult = { result: "VALID" | "USED" | "UNKNOWN"; usedAt?: string } | { error: string };

type Feedback = { kind: "VALID" | "USED" | "UNKNOWN" | "ERROR"; message: string };

const FEEDBACK_STYLES: Record<Feedback["kind"], string> = {
  VALID: "border-success-border bg-success-light text-success",
  USED: "border-error-border bg-error-light text-error",
  UNKNOWN: "border-error-border bg-error-light text-error",
  ERROR: "border-error-border bg-error-light text-error",
};

/**
 * Door mode: organizer-only, in their own session (no third-party delegation
 * — see the design's known limitation). Camera scan or typed short code both
 * hit the same atomic endpoint; the response is only VALID/USED/UNKNOWN.
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
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [manualBusy, setManualBusy] = useState(false);

  const address = user?.address;

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
        setFeedback({ kind: "ERROR", message: data.error });
      } else if (data.result === "VALID") {
        setFeedback({ kind: "VALID", message: "✓ Válido — dejalo pasar" });
      } else if (data.result === "USED") {
        setFeedback({
          kind: "USED",
          message: `Ya fue usado${data.usedAt ? ` (${new Date(data.usedAt).toLocaleString("es-BO")})` : ""}`,
        });
      } else {
        setFeedback({ kind: "UNKNOWN", message: "Código desconocido" });
      }
    } catch (err) {
      setFeedback({
        kind: "ERROR",
        message: err instanceof Error ? err.message : "No se pudo validar",
      });
    } finally {
      // Brief cooldown so the same code isn't re-scanned mid-feedback.
      setTimeout(() => {
        busyRef.current = false;
      }, 1500);
    }
  }

  useEffect(() => {
    if (!address || !videoRef.current) return;
    let cancelled = false;

    QrScanner.hasCamera().then((hasCamera) => {
      if (cancelled || !hasCamera || !videoRef.current) {
        if (!hasCamera) setCameraError("No se detectó cámara. Usá el código manual.");
        return;
      }
      const scanner = new QrScanner(videoRef.current, (result) => void validate(result.data), {
        highlightScanRegion: true,
        highlightCodeOutline: true,
        preferredCamera: "environment",
      });
      scannerRef.current = scanner;
      scanner.start().catch((err) => {
        setCameraError(err instanceof Error ? err.message : "No se pudo abrir la cámara");
      });
    });

    return () => {
      cancelled = true;
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, id]);

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    if (!manualCode.trim()) return;
    setManualBusy(true);
    await validate(manualCode.trim().toUpperCase());
    setManualCode("");
    setManualBusy(false);
  }

  if (authLoading) return null;

  if (!user) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-12 text-center">
        <PollarLogo size={72} />
        <p className="max-w-sm text-muted">Iniciá sesión con la cuenta organizadora.</p>
        <LoginButton />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <header className="flex items-center gap-2.5 py-2">
        <PollarLogo size={28} />
        <h1 className="text-xl font-bold tracking-tight">Modo puerta</h1>
      </header>

      <Card className="overflow-hidden p-0">
        <video ref={videoRef} className="aspect-square w-full bg-black object-cover" muted playsInline />
      </Card>
      {cameraError && <p className="text-center text-sm text-muted">{cameraError}</p>}

      {feedback && (
        <div className={`rounded-xl border px-4 py-3 text-center text-sm font-semibold ${FEEDBACK_STYLES[feedback.kind]}`}>
          {feedback.message}
        </div>
      )}

      <Card>
        <form onSubmit={submitManual} className="flex items-end gap-2">
          <Input
            label="Código de puerta (manual)"
            placeholder="ABCD1234"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            className="flex-1 font-mono uppercase"
          />
          <Button type="submit" loading={manualBusy} disabled={!manualCode.trim()}>
            Validar
          </Button>
        </form>
      </Card>
    </main>
  );
}
