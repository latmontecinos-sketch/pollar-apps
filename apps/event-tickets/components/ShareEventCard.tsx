"use client";

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { TicketQr } from "@/components/TicketQr";
import { formatEventDateTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";

const noopSubscribe = () => () => {};

/**
 * The organizer's main job after creating an event: getting the public link
 * out. Copy, WhatsApp (how events actually spread in Bolivia), the native
 * share sheet when the phone has one, and a printable QR for posters.
 */
export function ShareEventCard({
  eventId,
  eventName,
  datetimeUtc,
  accessCode,
}: {
  eventId: string;
  eventName: string;
  datetimeUtc: string;
  /** A private event's code: the shared link opens it without typing. */
  accessCode?: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  // Browser-only values: empty/false during SSR, real after hydration.
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => "");
  const canShare = useSyncExternalStore(
    noopSubscribe,
    () => typeof navigator.share === "function",
    () => false
  );
  const url = origin ? `${origin}/e/${eventId}${accessCode ? `?codigo=${accessCode}` : ""}` : "";
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const message = t.share.message(eventName, formatEventDateTime(datetimeUtc, locale), url);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-bold">
          <Icon name="share" size={18} className="text-primary" />
          {t.share.title}
        </h2>
        <p className="text-sm text-muted">{t.share.body}</p>
      </div>

      <button
        onClick={() => void copy()}
        className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-hover"
      >
        <span className="min-w-0 truncate font-mono text-sm">{url || "…"}</span>
        <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-primary">
          <Icon name={copied ? "check" : "copy"} size={16} />
          {copied ? t.common.copied : t.common.copy}
        </span>
      </button>

      <div className="grid grid-cols-2 gap-2">
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover"
        >
          <Icon name="message" size={17} />
          {t.common.whatsapp}
        </a>
        {canShare ? (
          <Button
            variant="secondary"
            onClick={() => void navigator.share({ title: eventName, text: message, url }).catch(() => {})}
          >
            <Icon name="share" size={17} />
            {t.common.share}
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => setShowQr((v) => !v)}>
            <Icon name="qr" size={17} />
            {showQr ? t.share.qrButtonHide : t.share.qrButton}
          </Button>
        )}
      </div>

      {canShare && (
        <button
          onClick={() => setShowQr((v) => !v)}
          className="flex items-center justify-center gap-1.5 text-sm font-semibold text-primary"
        >
          <Icon name="qr" size={16} />
          {showQr ? t.share.hideQr : t.share.showQr}
        </button>
      )}

      {showQr && url && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-background p-4">
          <TicketQr value={url} size={200} alt={eventName} />
          <p className="text-center text-xs text-muted">{t.share.qrNote}</p>
        </div>
      )}
    </Card>
  );
}
