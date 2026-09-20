"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { formatAmount, formatEventDateTime, salesClosed } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { AppHeader } from "@/components/AppHeader";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { Spinner } from "@/components/ui/Spinner";

type EventRow = {
  id: string;
  name: string;
  datetimeUtc: string;
  place: string;
  priceDecimal: string;
  capacity: number;
  reserved: number;
  paid: number;
};

type LoadState = { step: "loading" } | { step: "loaded"; events: EventRow[] } | { step: "error" };

function CreateButton({ label }: { label: string }) {
  return (
    <Link
      href="/organizador/nuevo"
      className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover"
    >
      <Icon name="plus" size={18} />
      {label}
    </Link>
  );
}

export default function MisEventosPage() {
  const { user, isLoading: authLoading } = usePollarAuth();
  const t = useT();
  const locale = useLocale();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });

  const [state, setState] = useState<LoadState>({ step: "loading" });
  const address = user?.address;

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      const client = pollarRef.current.getClient();
      const res = await pollarFetch(client, address, "/api/events/mine");
      if (cancelled) return;
      if (!res.ok) return setState({ step: "error" });
      const data = (await res.json()) as { events: EventRow[] };
      setState({ step: "loaded", events: data.events });
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (authLoading) return null;

  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <AppHeader title={t.myEvents.title} back={{ href: "/app", label: t.common.home }} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PollarLogo size={64} />
          <p className="max-w-sm text-muted">{t.myEvents.loginNote}</p>
          <LoginButton />
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title={t.myEvents.title} back={{ href: "/app", label: t.common.home }} />

      {state.step === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {state.step === "error" && (
        <Card>
          <p className="text-center text-sm text-error">{t.myEvents.loadError}</p>
        </Card>
      )}

      {state.step === "loaded" && state.events.length === 0 && (
        <Card>
          <EmptyState
            title={t.myEvents.emptyTitle}
            description={t.myEvents.emptyBody}
            action={<CreateButton label={t.myEvents.create} />}
          />
        </Card>
      )}

      {state.step === "loaded" && state.events.length > 0 && (
        <>
          <CreateButton label={t.myEvents.create} />
          {state.events.map((event) => {
            const closed = salesClosed(event.datetimeUtc);
            const soldPct = Math.min(100, Math.round((event.paid / event.capacity) * 100));
            return (
              <Link key={event.id} href={`/organizador/eventos/${event.id}`}>
                <Card className="flex flex-col gap-3 p-5 transition-colors hover:border-primary/40 hover:bg-surface-hover">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-semibold">{event.name}</h2>
                      <p className="text-sm text-muted first-letter:uppercase">
                        {formatEventDateTime(event.datetimeUtc, locale)} · {event.place}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        closed ? "bg-surface text-muted" : "bg-success-light text-success"
                      }`}
                    >
                      {closed ? t.myEvents.finished : t.myEvents.onSale}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-xs text-muted">
                      <span>{t.myEvents.sold(event.paid, event.capacity)}</span>
                      <span className="font-mono">
                        {t.myEvents.each(formatAmount(event.priceDecimal, locale))}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${soldPct}%` }} />
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </>
      )}
    </main>
  );
}
