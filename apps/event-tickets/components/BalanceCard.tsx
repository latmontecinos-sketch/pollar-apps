"use client";

import { useEffect } from "react";
import { usePollar } from "@pollar/react";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { useBalance } from "@/hooks/useBalance";
import { formatAmount } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";

/** The wallet card: the app's primary balance on a branded Pollar-blue card. */
export function BalanceCard() {
  const { balance, currency, isLoading, error, refresh } = useBalance();
  const { isAuthenticated, tx } = usePollar();
  const t = useT();
  const locale = useLocale();

  // `tx` is the SDK's global transaction state machine, so this catches every
  // payment made anywhere in the app (PayButton, Pollar's send modal, …).
  // 'submitted' covers payments the network accepted but hasn't confirmed yet.
  useEffect(() => {
    if (tx.step === "success" || tx.step === "submitted") {
      void refresh();
    }
  }, [tx.step, refresh]);

  if (!isAuthenticated) return null;

  return (
    <section className="relative w-full overflow-hidden rounded-2xl bg-primary p-6 text-primary-foreground shadow-md">
      {/* subtle brand watermark */}
      <div className="pointer-events-none absolute -right-4 -bottom-6">
        <PollarLogo size={120} colorClass="bg-primary-foreground/10" />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-primary-foreground/75">
          {t.account.balance}
        </span>
        <button
          onClick={() => void refresh()}
          disabled={isLoading}
          className="text-sm font-semibold text-primary-foreground/75 transition-colors hover:text-primary-foreground disabled:opacity-50"
        >
          {t.account.refresh}
        </button>
      </div>

      {error ? (
        <p className="mt-3 max-w-[85%] text-sm leading-6 text-primary-foreground/90">
          {error}
        </p>
      ) : isLoading && balance === null ? (
        <div className="mt-3 h-11 w-40 animate-pulse rounded-xl bg-primary-foreground/20" />
      ) : (
        <p
          className="mt-2 font-mono text-5xl font-semibold tabular-nums tracking-tight"
          title={balance ?? undefined}
        >
          {formatAmount(balance, locale)}
          <span className="ml-2 text-lg font-normal text-primary-foreground/75">
            {currency}
          </span>
        </p>
      )}
    </section>
  );
}
