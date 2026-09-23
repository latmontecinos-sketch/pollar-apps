"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { formatAmount, formatTimestamp, shortAddress } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { explorerTxUrl } from "@/lib/network";
import { AppHeader } from "@/components/AppHeader";
import { Card } from "@/components/ui/Card";
import { RefundButton } from "@/components/RefundButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { Spinner } from "@/components/ui/Spinner";

type SaleStatus = "pending" | "paid" | "expired" | "unclaimed" | "refunded";

type Sale = {
  id: string;
  buyerPollarId: string;
  status: SaleStatus;
  amountDecimal: string;
  txHash: string | null;
  refundTxHash: string | null;
  createdAt: string;
  usedAt: string | null;
  ticketTypeName: string | null;
};

type LoadState =
  | { step: "loading" }
  | { step: "forbidden" }
  | { step: "not_found" }
  | { step: "loaded"; sales: Sale[]; paidTotalDecimal: string; checkedIn: number };

const STATUS_STYLE: Record<SaleStatus, string> = {
  paid: "bg-success-light text-success",
  pending: "bg-primary-light text-primary",
  expired: "bg-surface text-muted",
  unclaimed: "bg-error-light text-error",
  refunded: "bg-surface text-muted",
};

export default function SalesPage({
  params,
}: PageProps<"/organizador/eventos/[id]/ventas">) {
  const { id } = use(params);
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

  const load = useCallback(async () => {
    if (!address) return;
    const client = pollarRef.current.getClient();
    const res = await pollarFetch(client, address, `/api/events/${id}/sales`);
    if (res.status === 404) return setState({ step: "not_found" });
    if (res.status === 403 || res.status === 401) return setState({ step: "forbidden" });
    const data = (await res.json()) as { sales: Sale[]; paidTotalDecimal: string; checkedIn: number };
    setState({ step: "loaded", ...data });
  }, [address, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (authLoading) return null;

  const back = { href: `/organizador/eventos/${id}`, label: t.panel.title };

  const statusLabel: Record<SaleStatus, string> = {
    paid: t.sales.statusPaid,
    pending: t.sales.statusPending,
    expired: t.sales.statusExpired,
    unclaimed: t.sales.statusUnclaimed,
    refunded: t.sales.statusRefunded,
  };

  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <AppHeader title={t.sales.title} back={back} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PollarLogo size={64} />
          <p className="max-w-sm text-muted">{t.sales.loginNote}</p>
          <LoginButton />
        </div>
      </main>
    );
  }

  const counts =
    state.step === "loaded"
      ? state.sales.reduce<Record<SaleStatus, number>>(
          (acc, s) => ({ ...acc, [s.status]: acc[s.status] + 1 }),
          { paid: 0, pending: 0, expired: 0, unclaimed: 0, refunded: 0 }
        )
      : null;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title={t.sales.title} back={back} />

      {state.step === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {state.step === "not_found" && (
        <Card>
          <p className="text-center text-sm text-muted">{t.sales.notFound}</p>
        </Card>
      )}

      {state.step === "forbidden" && (
        <Card className="flex flex-col gap-2 text-center">
          <p className="font-semibold text-error">{t.sales.forbiddenTitle}</p>
          <p className="text-sm text-muted">{t.sales.forbiddenBody}</p>
        </Card>
      )}

      {state.step === "loaded" && counts && (
        <>
          <section className="relative overflow-hidden rounded-2xl bg-primary p-6 text-primary-foreground shadow-md">
            <span className="text-sm text-primary-foreground/75">{t.sales.revenue}</span>
            <p className="mt-1 font-mono text-4xl font-semibold tabular-nums">
              {formatAmount(state.paidTotalDecimal, locale)}
              <span className="ml-2 text-base font-normal text-primary-foreground/75">USDC</span>
            </p>
            <p className="mt-2 text-sm text-primary-foreground/80">
              {t.sales.summary(counts.paid, state.checkedIn)}
            </p>
          </section>

          {counts.unclaimed > 0 && (
            <div className="flex items-start gap-3 rounded-2xl border border-error-border bg-error-light p-4 text-sm leading-6">
              <Icon name="alert" size={20} className="mt-0.5 text-error" />
              <p>
                <span className="font-semibold text-error">{t.sales.lateStrong(counts.unclaimed)}</span>{" "}
                {t.sales.lateBody}
              </p>
            </div>
          )}

          {state.sales.length === 0 ? (
            <Card>
              <EmptyState title={t.sales.emptyTitle} description={t.sales.emptyBody} />
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              <h2 className="px-1 text-sm font-semibold text-muted">
                {t.sales.movements(state.sales.length)}
              </h2>
              {state.sales.map((sale) => (
                <Card key={sale.id} className="flex items-center justify-between gap-3 p-4 text-sm">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono text-xs" title={sale.buyerPollarId}>
                      {t.sales.buyer(shortAddress(sale.buyerPollarId))}
                    </span>
                    <span className="text-xs text-muted">
                      {formatTimestamp(sale.createdAt, locale)}
                      {sale.ticketTypeName ? ` · ${sale.ticketTypeName}` : ""}
                    </span>
                    {sale.txHash && (
                      <a
                        href={explorerTxUrl(sale.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs font-medium text-primary underline"
                      >
                        {t.sales.receipt} <Icon name="external" size={12} />
                      </a>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="font-mono font-semibold">
                      {formatAmount(sale.amountDecimal, locale)} USDC
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[sale.status]}`}>
                      {statusLabel[sale.status]}
                    </span>
                    {sale.status === "unclaimed" && (
                      <RefundButton saleId={sale.id} onRefunded={() => void load()} />
                    )}
                    {sale.usedAt && (
                      <span className="flex items-center gap-1 text-xs text-success">
                        <Icon name="check" size={12} /> {t.sales.entered}
                      </span>
                    )}
                  </div>
                </Card>
              ))}
              <p className="px-1 pt-1 text-xs leading-5 text-muted-light">{t.sales.legend}</p>
            </div>
          )}
        </>
      )}
    </main>
  );
}
