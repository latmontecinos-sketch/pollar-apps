"use client";

import { use, useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { shortAddress } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { Spinner } from "@/components/ui/Spinner";

type Sale = {
  id: string;
  buyerPollarId: string;
  status: "pending" | "paid" | "expired" | "unclaimed";
  amountDecimal: string;
  txHash: string | null;
  createdAt: string;
};

type LoadState =
  | { step: "loading" }
  | { step: "forbidden" }
  | { step: "not_found" }
  | { step: "loaded"; sales: Sale[]; paidTotalDecimal: string };

const STATUS_STYLE: Record<Sale["status"], string> = {
  paid: "bg-success-light text-success",
  pending: "bg-primary-light text-primary",
  expired: "bg-surface text-muted",
  unclaimed: "bg-error-light text-error",
};

const STATUS_LABEL: Record<Sale["status"], string> = {
  paid: "Pagado",
  pending: "Pendiente",
  expired: "Expirado",
  unclaimed: "Sin reclamar",
};

export default function SalesPage({
  params,
}: PageProps<"/organizador/eventos/[id]/ventas">) {
  const { id } = use(params);
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
      const res = await pollarFetch(client, address, `/api/events/${id}/sales`);
      if (cancelled) return;
      if (res.status === 404) return setState({ step: "not_found" });
      if (res.status === 403 || res.status === 401) return setState({ step: "forbidden" });
      const data = (await res.json()) as { sales: Sale[]; paidTotalDecimal: string };
      setState({ step: "loaded", sales: data.sales, paidTotalDecimal: data.paidTotalDecimal });
    })();
    return () => {
      cancelled = true;
    };
  }, [address, id]);

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

  const counts =
    state.step === "loaded"
      ? state.sales.reduce<Record<Sale["status"], number>>(
          (acc, s) => ({ ...acc, [s.status]: acc[s.status] + 1 }),
          { paid: 0, pending: 0, expired: 0, unclaimed: 0 }
        )
      : null;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <header className="flex items-center gap-2.5 py-2">
        <PollarLogo size={28} />
        <h1 className="text-xl font-bold tracking-tight">Ventas</h1>
      </header>

      {state.step === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {state.step === "not_found" && (
        <Card>
          <p className="text-center text-sm text-muted">Ese evento no existe.</p>
        </Card>
      )}

      {state.step === "forbidden" && (
        <Card>
          <p className="text-center text-sm text-error">
            Esta cuenta no es la organizadora de este evento (403).
          </p>
        </Card>
      )}

      {state.step === "loaded" && counts && (
        <>
          <Card className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Recaudado</span>
              <span className="font-mono text-lg font-semibold">
                {state.paidTotalDecimal} USDC
              </span>
            </div>
            <div className="flex justify-between text-xs text-muted">
              <span>{counts.paid} pagadas</span>
              <span>{counts.pending} pendientes</span>
              <span>{counts.expired} expiradas</span>
              {counts.unclaimed > 0 && (
                <span className="font-semibold text-error">{counts.unclaimed} sin reclamar</span>
              )}
            </div>
          </Card>

          {state.sales.length === 0 && (
            <Card>
              <p className="text-center text-sm text-muted">Todavía no hay ventas.</p>
            </Card>
          )}

          {state.sales.map((sale) => (
            <Card key={sale.id} className="flex items-center justify-between gap-3 text-sm">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-xs text-muted">
                  {shortAddress(sale.buyerPollarId)}
                </span>
                {sale.txHash ? (
                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${sale.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary underline"
                  >
                    Ver transacción →
                  </a>
                ) : (
                  <span className="text-xs text-muted-light">
                    {new Date(sale.createdAt).toLocaleString("es-BO")}
                  </span>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="font-mono font-semibold">{sale.amountDecimal} USDC</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[sale.status]}`}
                >
                  {STATUS_LABEL[sale.status]}
                </span>
              </div>
            </Card>
          ))}
        </>
      )}
    </main>
  );
}
