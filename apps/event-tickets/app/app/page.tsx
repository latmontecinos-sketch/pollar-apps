"use client";

import { useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { BalanceCard } from "@/components/BalanceCard";
import { buyerSteps, GuideSteps } from "@/components/GuideSteps";
import { LoginButton } from "@/components/LoginButton";
import { ReceiveModal } from "@/components/ReceiveModal";
import { WelcomeGiftCard } from "@/components/WelcomeGiftCard";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { ListRow } from "@/components/ui/ListRow";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { useBalance } from "@/hooks/useBalance";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useT } from "@/lib/i18n/client";

/** Signed out, inside the app: a short way in, with the product page one tap away. */
function SignedOut() {
  const t = useT();
  return (
    <AppShell
      hero={
        <section className="flex flex-col items-center gap-4 pt-2 text-center">
          <PollarLogo size={72} colorClass="bg-band-foreground" />
          <h1 className="text-3xl font-extrabold leading-tight tracking-tight">
            {t.landing.titleLine1}
            <span className="block text-band-foreground/80">{t.landing.titleLine2}</span>
          </h1>
        </section>
      }
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="max-w-sm text-base leading-7 text-muted">{t.landing.subtitle}</p>
        <div className="flex w-full max-w-xs flex-col gap-2">
          <LoginButton label={t.landing.cta} className="w-full py-3.5 text-base" />
          <Link
            href="/como-funciona"
            className="rounded-full py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary-light"
          >
            {t.landing.seeHow}
          </Link>
        </div>
      </div>

      <Card className="flex flex-col gap-5">
        <h2 className="text-lg font-bold tracking-tight">{t.landing.stepsTitle}</h2>
        <GuideSteps steps={buyerSteps(t).slice(0, 4)} />
      </Card>
    </AppShell>
  );
}

/** The two quick actions under the balance: light pills on the band. */
const bandPill =
  "flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-background text-sm font-semibold text-foreground shadow-sm transition-all hover:text-primary active:scale-[0.98]";

/** The app's own home: balance on the band, then the gift and what you can do with it. */
export default function AppHome() {
  const { user } = usePollarAuth();
  const { balance, isLoading } = useBalance();
  const [receiveOpen, setReceiveOpen] = useState(false);
  const t = useT();

  if (!user) return <SignedOut />;

  const emptyBalance = !isLoading && balance !== null && Number(balance) < 0.01;

  return (
    <AppShell
      title={t.home.greeting}
      subtitle={t.home.title}
      hero={
        <div className="flex flex-col gap-4">
          <BalanceCard />
          <div className="flex gap-2">
            <button onClick={() => setReceiveOpen(true)} className={bandPill}>
              <Icon name="wallet" size={17} className="text-primary" />
              {t.home.receive}
            </button>
            <Link href="/como-funciona#usdc" className={bandPill}>
              <Icon name="plus" size={17} className="text-primary" />
              {t.home.testUsdc}
            </Link>
          </div>
        </div>
      }
    >
      <WelcomeGiftCard />

      {emptyBalance && (
        <div className="flex items-start gap-3 rounded-3xl border border-warning-border bg-warning-light p-4 text-sm leading-6">
          <Icon name="alert" size={20} className="mt-0.5 text-warning" />
          <p>
            <span className="font-semibold">{t.home.emptyBalanceStrong}</span>{" "}
            {t.home.emptyBalanceBody}{" "}
            <Link href="/como-funciona#usdc" className="font-semibold text-primary underline">
              {t.home.emptyBalanceLink}
            </Link>
            .
          </p>
        </div>
      )}

      <nav className="flex flex-col gap-1">
        <ListRow
          href="/mis-pases"
          icon="ticket"
          tone="strong"
          title={t.home.ticketsTile}
          subtitle={t.home.ticketsTileBody}
        />
        <ListRow href="/escanear" icon="scan" tone="mid" title={t.scan.open} subtitle={t.scan.body} />
        <ListRow
          href="/mis-eventos"
          icon="calendar"
          tone="soft"
          title={t.home.eventsTile}
          subtitle={t.home.eventsTileBody}
        />
        <ListRow
          href="/organizador/nuevo"
          icon="plus"
          tone="mid"
          title={t.home.createTile}
          subtitle={t.home.createTileBody}
        />
      </nav>

      <Link
        href="/como-funciona"
        className="flex items-center gap-3 rounded-3xl border border-dashed border-tile-soft p-4 text-sm transition-colors hover:border-primary/40 hover:bg-background"
      >
        <Icon name="help" size={20} className="text-primary" />
        <span className="flex-1">
          <span className="font-semibold">{t.home.firstTimeStrong}</span>{" "}
          <span className="text-muted">{t.home.firstTimeBody}</span>
        </span>
        <Icon name="chevron" size={18} className="text-muted-light" />
      </Link>

      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </AppShell>
  );
}
