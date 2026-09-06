"use client";

import { useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { formatEventDateTime } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { Spinner } from "@/components/ui/Spinner";

type Sale = {
  id: string;
  status: "pending" | "paid" | "expired" | "unclaimed";
  amountDecimal: string;
  event: { id: string; name: string; datetimeUtc: string; place: string };
  ticket: { code: string; doorCode: string | null; usedAt: string | null } | null;
};

type LoadState = { step: "loading" } | { step: "loaded"; sales: Sale[] } | { step: "error" };

const STATUS_LABEL: Record<Sale["status"], string> = {
  pending: "Pendiente de pago",
  paid: "Pagado",
  expired: "Expirado",
  unclaimed: "Pago sin reclamar — contactá al organizador",
};

export default function MisPasesPage() {
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
      const res = await pollarFetch(client, address, "/api/sales/mine");
      if (cancelled) return;
      if (!res.ok) return setState({ step: "error" });
      const data = (await res.json()) as { sales: Sale[] };
      setState({ step: "loaded", sales: data.sales });
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
        <p className="max-w-sm text-muted">Iniciá sesión para ver tus pases.</p>
        <LoginButton />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <header className="flex items-center gap-2.5 py-2">
        <PollarLogo size={28} />
        <h1 className="text-xl font-bold tracking-tight">Mis pases</h1>
      </header>

      {state.step === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {state.step === "error" && (
        <Card>
          <p className="text-center text-sm text-error">No se pudieron cargar tus pases.</p>
        </Card>
      )}

      {state.step === "loaded" && state.sales.length === 0 && (
        <Card>
          <p className="text-center text-sm text-muted">Todavía no compraste ningún pase.</p>
        </Card>
      )}

      {state.step === "loaded" &&
        state.sales.map((sale) => (
          <Card key={sale.id} className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">{sale.event.name}</h2>
                <p className="text-sm text-muted">
                  {formatEventDateTime(sale.event.datetimeUtc)} · {sale.event.place}
                </p>
              </div>
              <span className="whitespace-nowrap font-mono text-xs font-semibold text-muted">
                {sale.amountDecimal} USDC
              </span>
            </div>

            {sale.ticket ? (
              <div className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2">
                <span className="font-mono text-xs">Código: {sale.ticket.code}</span>
                <span className="font-mono text-xs">Código de puerta: {sale.ticket.doorCode}</span>
                {sale.ticket.usedAt && (
                  <span className="text-xs text-muted">
                    Usado el {new Date(sale.ticket.usedAt).toLocaleString("es-BO")}
                  </span>
                )}
              </div>
            ) : (
              <span
                className={`text-sm font-medium ${
                  sale.status === "unclaimed" ? "text-error" : "text-muted"
                }`}
              >
                {STATUS_LABEL[sale.status]}
              </span>
            )}
          </Card>
        ))}
    </main>
  );
}
