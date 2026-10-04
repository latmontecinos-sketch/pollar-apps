"use client";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { formatAmount } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";

/**
 * The "review your purchase" step of the checkout, before anything is paid:
 * what is bought, the total, and (said plainly, because it starts when the
 * buyer taps Pay) that the seat is held for ten minutes. Purely visual: the
 * buy button decides what Cancel and Pay do (components/BuyButton.tsx).
 */
export function BuyConfirm({
  eventName,
  ticketTypeName,
  priceDecimal,
  onCancel,
  onPay,
}: {
  eventName: string;
  ticketTypeName: string;
  priceDecimal: string;
  onCancel: () => void;
  onPay: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
      <p className="text-base font-bold tracking-tight">{t.buy.confirmTitle}</p>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">{t.buy.confirmTicket}</dt>
          <dd className="text-right font-medium">
            {eventName}
            <span className="block text-xs text-muted">{ticketTypeName}</span>
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">{t.buy.confirmTotal}</dt>
          <dd className="font-mono text-base font-bold">{formatAmount(priceDecimal, locale)} USDC</dd>
        </div>
      </dl>
      {/* The 10 minutes, said plainly before the button that starts them. */}
      <div className="flex items-start gap-3 rounded-xl bg-accent-soft px-3.5 py-3 text-accent-text">
        <Icon name="clock" size={20} className="mt-0.5 shrink-0" />
        <p className="flex flex-col gap-0.5 text-sm leading-5">
          <span className="font-bold">{t.buy.holdTitle(t.hold.minutes)}</span>
          <span className="text-xs">{t.buy.holdBody}</span>
        </p>
      </div>
      <p className="text-xs leading-5 text-muted">{t.buy.confirmNote}</p>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t.common.cancel}
        </Button>
        <Button onClick={onPay}>{t.buy.pay}</Button>
      </div>
    </div>
  );
}
