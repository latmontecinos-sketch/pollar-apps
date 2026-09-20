"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import QrScanner from "qr-scanner";
import { AppHeader } from "@/components/AppHeader";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/lib/i18n/client";

/** `…/e/<id>` from any QR (poster, invitation, another phone's screen). */
function eventPathFrom(raw: string): string | null {
  const value = raw.trim();
  const direct = value.match(/^\/?e\/([A-Za-z0-9-]+)$/);
  if (direct) return `/e/${direct[1]}`;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/e\/([A-Za-z0-9-]+)$/);
    return match ? `/e/${match[1]}` : null;
  } catch {
    return null;
  }
}

/** Opens an event by scanning its QR — the poster version of pasting a link. */
export default function ScanPage() {
  const t = useT();
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const handledRef = useRef(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    let cancelled = false;

    QrScanner.hasCamera().then((hasCamera) => {
      if (cancelled || !videoRef.current) return;
      if (!hasCamera) {
        setCameraError(t.door.noCamera);
        return;
      }
      const scanner = new QrScanner(
        videoRef.current,
        (result) => {
          if (handledRef.current) return;
          const path = eventPathFrom(result.data);
          if (!path) {
            setMessage(t.scan.notAnEvent);
            return;
          }
          handledRef.current = true;
          setMessage(t.scan.opening);
          scannerRef.current?.stop();
          router.push(path);
        },
        { highlightScanRegion: true, highlightCodeOutline: true, preferredCamera: "environment" }
      );
      scannerRef.current = scanner;
      scanner.start().catch(() => setCameraError(t.door.cameraDenied));
    });

    return () => {
      cancelled = true;
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title={t.scan.title} back={{ href: "/", label: t.common.home }} />

      <p className="px-1 text-sm leading-6 text-muted">{t.scan.body}</p>

      <Card className="overflow-hidden p-0">
        <video ref={videoRef} className="aspect-square w-full bg-foreground object-cover" muted playsInline />
      </Card>

      {cameraError && (
        <p className="rounded-xl border border-warning-border bg-warning-light px-3 py-2 text-sm">
          {cameraError}
        </p>
      )}

      {message && (
        <p className="flex items-center justify-center gap-2 text-sm font-medium text-muted">
          <Icon name="qr" size={16} className="text-primary" />
          {message}
        </p>
      )}
    </main>
  );
}
