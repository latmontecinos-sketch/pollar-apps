"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/lib/i18n/client";

function remaining(expiresAtUtc: string): number {
  return Math.max(0, new Date(expiresAtUtc).getTime() - Date.now());
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Live countdown of a held seat. A buyer mid-payment needs to know how
 * long the hold lasts — and everyone else needs that seat back the second
 * it lapses, so this also tells the page when it's over.
 */
export function HoldCountdown({
  expiresAtUtc,
  onExpired,
}: {
  expiresAtUtc: string;
  onExpired?: () => void;
}) {
  const t = useT();
  // The clock is derived from `Date.now()` at render time; the interval only
  // nudges React to render again, so the deadline is never stored twice.
  const [, tick] = useState(0);
  const left = remaining(expiresAtUtc);

  useEffect(() => {
    const timer = setInterval(() => {
      tick((n) => n + 1);
      if (remaining(expiresAtUtc) === 0) {
        clearInterval(timer);
        onExpired?.();
      }
    }, 1000);
    return () => clearInterval(timer);
    // `onExpired` is a render-new closure in most callers; the effect only
    // needs to restart when the deadline itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAtUtc]);

  if (left === 0) {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <Icon name="clock" size={14} /> {t.hold.expired}
      </span>
    );
  }

  const urgent = left < 60_000;
  return (
    <span
      className={`flex items-center gap-1.5 text-xs font-semibold ${urgent ? "text-error" : "text-primary"}`}
      aria-live="off"
    >
      <Icon name="clock" size={14} />
      {t.hold.countdown(clock(left))}
    </span>
  );
}
