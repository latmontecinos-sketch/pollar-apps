"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { formatTimestamp } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";

type Item = { id: string; kind: string; eventName: string; at: string };

/** "Seen up to" marker: per device, so it never needs a round trip. */
const SEEN_KEY = "pollarpass:notificaciones-vistas";

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0);
  } catch {
    return 0;
  }
}

function writeSeen(at: number) {
  try {
    localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    // Private mode: the badge just comes back next time.
  }
}

/**
 * The two things people asked to be told about: a sale of their event, and
 * their own ticket being accepted at a door. Fetched on open and every two
 * minutes while the tab is around.
 */
export function NotificationsButton() {
  const { user, verified } = usePollarAuth();
  const t = useT();
  const locale = useLocale();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [seen, setSeen] = useState(0);
  const address = user?.address;

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const res = await pollarFetch(pollarRef.current.getClient(), address, "/api/notifications");
      if (!res.ok) return setFailed(true);
      const data = (await res.json()) as { items: Item[] };
      setItems(data.items);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [address]);

  useEffect(() => {
    if (!address || !verified) return;
    // Both in callbacks, never in the effect body: the first fetch goes
    // through a timeout so the effect itself doesn't set state.
    const first = setTimeout(() => {
      setSeen(readSeen());
      void load();
    }, 0);
    const timer = setInterval(() => void load(), 120_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [address, verified, load]);

  if (!user) return null;

  const unread = (items ?? []).filter((item) => new Date(item.at).getTime() > seen).length;

  function openPanel() {
    setOpen(true);
    void load();
    const newest = items && items.length > 0 ? new Date(items[0].at).getTime() : Date.now();
    writeSeen(newest);
    setSeen(newest);
  }

  return (
    <>
      <button
        onClick={openPanel}
        aria-label={t.notifications.title}
        title={t.notifications.title}
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-muted transition-colors hover:bg-surface-hover hover:text-primary"
      >
        <Icon name="bell" size={18} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={t.notifications.title}>
        {items === null && !failed && (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        )}
        {failed && <p className="py-6 text-center text-sm text-error">{t.notifications.loadError}</p>}
        {items !== null && items.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Icon name="bell" size={28} className="text-muted-light" />
            <p className="font-semibold">{t.notifications.empty}</p>
            <p className="max-w-xs text-sm text-muted">{t.notifications.emptyHint}</p>
          </div>
        )}
        {items !== null && items.length > 0 && (
          <ul className="flex flex-col divide-y divide-border">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 py-3">
                <span
                  className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                    item.kind === "sold" ? "bg-primary-light text-primary" : "bg-success-light text-success"
                  }`}
                >
                  <Icon name={item.kind === "sold" ? "wallet" : "check"} size={16} />
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm leading-6">
                    {item.kind === "sold"
                      ? t.notifications.sold(item.eventName)
                      : t.notifications.checkedIn(item.eventName)}
                  </span>
                  <span className="text-xs text-muted">{formatTimestamp(item.at, locale)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}
