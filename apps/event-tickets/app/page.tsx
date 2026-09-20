"use client";

import { useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { BalanceCard } from "@/components/BalanceCard";
import { buyerSteps, GuideSteps } from "@/components/GuideSteps";
import { LoginButton } from "@/components/LoginButton";
import { ReceiveModal } from "@/components/ReceiveModal";
import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { useBalance } from "@/hooks/useBalance";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useT } from "@/lib/i18n/client";

const PROMISE_ICONS: IconName[] = ["wallet", "shield", "qr"];

function ActionTile({
  href,
  icon,
  title,
  description,
  primary = false,
}: {
  href: string;
  icon: IconName;
  title: string;
  description: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-4 rounded-2xl border p-4 shadow-sm transition-all duration-150 active:scale-[0.98] ${
        primary
          ? "border-primary bg-primary text-primary-foreground hover:bg-primary-hover"
          : "border-border bg-background hover:border-primary/40 hover:bg-primary-light"
      }`}
    >
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
          primary ? "bg-primary-foreground/15" : "bg-primary-light text-primary"
        }`}
      >
        <Icon name={icon} size={22} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold">{title}</span>
        <span className={`text-sm ${primary ? "text-primary-foreground/80" : "text-muted"}`}>
          {description}
        </span>
      </span>
      <Icon name="chevron" size={18} className={primary ? "text-primary-foreground/70" : "text-muted-light"} />
    </Link>
  );
}

function Landing() {
  const t = useT();
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader />

      <section className="flex flex-col items-center gap-5 pt-4 text-center">
        <PollarLogo size={84} />
        <span className="rounded-full bg-primary-light px-3 py-1 text-xs font-semibold text-primary">
          {t.landing.badge}
        </span>
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight">
          {t.landing.titleLine1}
          <span className="block text-primary">{t.landing.titleLine2}</span>
        </h1>
        <p className="max-w-sm text-base leading-7 text-muted">{t.landing.subtitle}</p>
        <div className="flex w-full max-w-xs flex-col gap-2">
          <LoginButton label={t.landing.cta} className="w-full py-3.5 text-base" />
          <Link
            href="/como-funciona"
            className="rounded-xl py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary-light"
          >
            {t.landing.seeHow}
          </Link>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3">
        <Card className="flex flex-col gap-2 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-light text-primary">
            <Icon name="ticket" />
          </span>
          <h2 className="font-semibold">{t.landing.buyerCardTitle}</h2>
          <p className="text-sm leading-5 text-muted">{t.landing.buyerCardBody}</p>
        </Card>
        <Card className="flex flex-col gap-2 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-light text-primary">
            <Icon name="calendar" />
          </span>
          <h2 className="font-semibold">{t.landing.organizerCardTitle}</h2>
          <p className="text-sm leading-5 text-muted">{t.landing.organizerCardBody}</p>
        </Card>
      </div>

      <Card className="flex flex-col gap-5">
        <h2 className="text-lg font-bold tracking-tight">{t.landing.stepsTitle}</h2>
        <GuideSteps steps={buyerSteps(t).slice(0, 4)} />
        <Link href="/como-funciona" className="text-sm font-semibold text-primary underline">
          {t.landing.fullGuide}
        </Link>
      </Card>

      <ul className="flex flex-col gap-2.5 px-1">
        {t.landing.promises.map((text, index) => (
          <li key={text} className="flex items-center gap-3 text-sm text-muted">
            <Icon name={PROMISE_ICONS[index]} size={18} className="text-primary" />
            {text}
          </li>
        ))}
      </ul>
    </main>
  );
}

export default function Home() {
  const { user } = usePollarAuth();
  const { balance, isLoading } = useBalance();
  const [receiveOpen, setReceiveOpen] = useState(false);
  const t = useT();

  if (!user) return <Landing />;

  const emptyBalance = !isLoading && balance !== null && Number(balance) < 0.01;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader />

      <div className="flex flex-col gap-0.5 px-1">
        <h1 className="text-2xl font-bold tracking-tight">{t.home.title}</h1>
        <p className="text-sm text-muted">{t.home.subtitle}</p>
      </div>

      <BalanceCard />

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setReceiveOpen(true)}
          className="flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface text-sm font-semibold transition-colors hover:bg-surface-hover"
        >
          <Icon name="wallet" size={17} className="text-primary" />
          {t.home.receive}
        </button>
        <Link
          href="/como-funciona#usdc"
          className="flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface text-sm font-semibold transition-colors hover:bg-surface-hover"
        >
          <Icon name="plus" size={17} className="text-primary" />
          {t.home.testUsdc}
        </Link>
      </div>

      {emptyBalance && (
        <div className="flex items-start gap-3 rounded-2xl border border-warning-border bg-warning-light p-4 text-sm leading-6">
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

      <div className="flex flex-col gap-3 pt-2">
        <ActionTile
          href="/escanear"
          icon="scan"
          title={t.scan.open}
          description={t.scan.body}
        />
        <ActionTile
          href="/mis-pases"
          icon="ticket"
          title={t.home.ticketsTile}
          description={t.home.ticketsTileBody}
          primary
        />
        <ActionTile
          href="/mis-eventos"
          icon="calendar"
          title={t.home.eventsTile}
          description={t.home.eventsTileBody}
        />
        <ActionTile
          href="/organizador/nuevo"
          icon="plus"
          title={t.home.createTile}
          description={t.home.createTileBody}
        />
      </div>

      <Link
        href="/como-funciona"
        className="mt-2 flex items-center gap-3 rounded-2xl border border-dashed border-border p-4 text-sm transition-colors hover:border-primary/40 hover:bg-primary-light"
      >
        <Icon name="help" size={20} className="text-primary" />
        <span className="flex-1">
          <span className="font-semibold">{t.home.firstTimeStrong}</span>{" "}
          <span className="text-muted">{t.home.firstTimeBody}</span>
        </span>
        <Icon name="chevron" size={18} className="text-muted-light" />
      </Link>

      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </main>
  );
}
