"use client";

import { useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { useBalance } from "@/hooks/useBalance";
import { formatAmount } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { claimFailure, pickWelcomeRule } from "@/lib/welcome";

type Offer = { id: string; amount: string; assetCode: string };

type State =
  | { step: "hidden" }
  | { step: "offer"; rule: Offer; error?: string }
  | { step: "claiming"; rule: Offer }
  | { step: "claimed"; rule: Offer };

/**
 * The welcome gift: a distribution rule configured in Pollar's dashboard
 * (once per user, lifetime), claimed from the SDK. Pollar decides who may
 * claim — this card only offers what `listDistributionRules()` says is
 * claimable and gets out of the way otherwise. The payout comes from the
 * app's distribution wallet, never from this app's server.
 */
export function WelcomeGiftCard() {
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });
  const { refresh } = useBalance();
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<State>({ step: "hidden" });
  const { isAuthenticated } = pollar;

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    pollarRef.current
      .getClient()
      .listDistributionRules()
      .then((rules) => {
        const rule = pickWelcomeRule(rules);
        if (!cancelled && rule) {
          setState({ step: "offer", rule: { id: rule.id, amount: rule.amount, assetCode: rule.assetCode } });
        }
      })
      // No rules, no card: a gift that can't be listed isn't worth an error.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  if (state.step === "hidden") return null;

  const { rule } = state;
  const amount = formatAmount(rule.amount, locale);

  async function claim() {
    setState({ step: "claiming", rule });
    try {
      await pollarRef.current.getClient().claimDistributionRule({ ruleId: rule.id });
      setState({ step: "claimed", rule });
      void refresh();
    } catch (err) {
      const failure = claimFailure(err);
      if (failure === "claimed") return setState({ step: "hidden" });
      setState({
        step: "offer",
        rule,
        error: failure === "gone" ? t.welcome.exhausted : t.welcome.error,
      });
    }
  }

  return (
    <section className="pollar-rise flex items-center gap-4 rounded-3xl bg-primary p-5 text-primary-foreground shadow-md">
      <span className="flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center rounded-full border-4 border-primary-foreground/25 border-t-primary-foreground">
        <Icon name={state.step === "claimed" ? "check" : "gift"} size={28} />
      </span>
      <span className="w-px self-stretch bg-primary-foreground/25" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-base font-bold leading-tight">{t.welcome.title}</p>
        {state.step === "claimed" ? (
          <p className="text-sm leading-5 text-primary-foreground/90">{t.welcome.claimed(amount, rule.assetCode)}</p>
        ) : (
          <>
            <p className="text-sm leading-5 text-primary-foreground/85">{t.welcome.body(amount, rule.assetCode)}</p>
            {state.step === "offer" && state.error && (
              <p className="text-xs leading-5 text-primary-foreground" role="alert">
                {state.error}
              </p>
            )}
            <button
              onClick={() => void claim()}
              disabled={state.step === "claiming"}
              className="inline-flex w-fit items-center gap-2 rounded-full bg-primary-foreground px-4 py-2 text-sm font-semibold text-primary shadow-sm transition-all enabled:active:scale-[0.97] disabled:opacity-70"
            >
              {state.step === "claiming" && <Spinner />}
              {t.welcome.claim(amount, rule.assetCode)}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
