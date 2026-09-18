"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { formatAmount, formatEventDateTime } from "@/lib/format";
import { Card } from "@/components/ui/Card";
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
};

type LoadState = { step: "loading" } | { step: "loaded"; events: EventRow[] } | { step: "error" };

export default function MisEventosPage() {
  const { user, isLoading: authLoading } = usePollarAuth();
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
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-12 text-center">
        <PollarLogo size={72} />
        <p className="max-w-sm text-muted">Iniciá sesión para ver los eventos que organizás.</p>
        <LoginButton />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <header className="flex items-center gap-2.5 py-2">
        <Link href="/" aria-label="Ir al inicio">
          <PollarLogo size={28} />
        </Link>
        <h1 className="text-xl font-bold tracking-tight">Mis eventos</h1>
      </header>

      {state.step === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {state.step === "error" && (
        <Card>
          <p className="text-center text-sm text-error">No se pudieron cargar tus eventos.</p>
        </Card>
      )}

      {state.step === "loaded" && state.events.length === 0 && (
        <Card>
          <p className="text-center text-sm text-muted">Todavía no organizaste ningún evento.</p>
        </Card>
      )}

      {state.step === "loaded" &&
        state.events.map((event) => (
          <Link key={event.id} href={`/organizador/eventos/${event.id}`}>
            <Card className="flex items-center justify-between gap-3 transition-colors hover:bg-surface-hover">
              <div>
                <h2 className="font-semibold">{event.name}</h2>
                <p className="text-sm text-muted">
                  {formatEventDateTime(event.datetimeUtc)} · {event.place}
                </p>
                <p className="mt-0.5 font-mono text-xs text-muted">
                  {event.reserved} / {event.capacity} vendidos · {formatAmount(event.priceDecimal)} USDC
                </p>
              </div>
            </Card>
          </Link>
        ))}
    </main>
  );
}
