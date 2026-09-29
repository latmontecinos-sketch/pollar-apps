"use client";

import { useEffect } from "react";
import { usePollar } from "@pollar/react";
import { Icon } from "@/components/ui/Icon";
import { useBalance } from "@/hooks/useBalance";
import { formatAmount } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";

/**
 * The balance, laid on the app shell's brand band: a label, the amount in
 * large type, and a quiet refresh. It sits in the band's `hero`, so it
 * inherits the band's colors instead of painting its own card.
 */
export function BalanceCard() {
  const { balance, currency, isLoading, error, refresh } = useBalance();
  const { isAuthenticated, tx } = usePollar();
  const t = useT();
  const locale = useLocale();

  // `tx` is the SDK's global transaction state machine, so this catches every
  // payment made anywhere in the app (via Pollar's SDK methods).
  // 'submitted' covers payments the network accepted but hasn't confirmed yet.
  useEffect(() => {
    if (tx.step === "success" || tx.step === "submitted") {
      void refresh();
    }
  }, [tx.step, refresh]);

  if (!isAuthenticated) return null;

  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm font-medium text-band-foreground/80">
        <Icon name="wallet" size={16} />
        <span>{t.home.balanceLabel}</span>
        <button
          onClick={() => void refresh()}
          disabled={isLoading}
          aria-label={t.account.refresh}
          title={t.account.refresh}
          className="ml-auto rounded-full px-2 py-0.5 text-xs font-semibold text-band-foreground/80 transition-colors hover:bg-band-foreground/15 hover:text-band-foreground disabled:opacity-50"
        >
          {t.account.refresh}
        </button>
      </div>

      {error ? (
        <p className="text-sm leading-6 text-band-foreground/90">{error}</p>
      ) : isLoading && balance === null ? (
        <div className="mt-1 h-11 w-44 animate-pulse rounded-xl bg-band-foreground/20" />
      ) : (
        <p className="font-mono text-[2.6rem] font-semibold leading-tight tabular-nums tracking-tight" title={balance ?? undefined}>
          {formatAmount(balance, locale)}
          <span className="ml-2 font-sans text-lg font-medium text-band-foreground/75">{currency}</span>
        </p>
      )}
    </section>
  );
}
