"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Renders `value` (the ticket's raw code — see lib/tickets.ts) as a scannable QR image. */
export function TicketQr({ value, size = 200 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { width: size, margin: 1 }).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!dataUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className="animate-pulse rounded-lg bg-surface"
        aria-hidden="true"
      />
    );
  }

  // eslint-disable-next-line @next/next/no-img-element -- a data: URL, not a remote asset next/image would optimize.
  return <img src={dataUrl} alt="QR del pase" width={size} height={size} className="rounded-lg" />;
}
