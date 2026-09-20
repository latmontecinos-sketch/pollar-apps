"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { buyerSteps, GuideSteps, organizerSteps } from "@/components/GuideSteps";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useT } from "@/lib/i18n/client";
import type { Dict } from "@/lib/i18n";

type Tab = "comprador" | "organizador" | "preguntas";

const TAB_IDS: Tab[] = ["comprador", "organizador", "preguntas"];
const FLOW_ICONS: IconName[] = ["plus", "share", "wallet", "qr"];

/** Stable ids: a link to #usdc keeps working in every language. */
const FAQ_IDS = [
  "usdc",
  "usdc-que-es",
  "billetera",
  "pague-sin-entrada",
  "reserva",
  "dos-veces",
  "reembolso",
  "privacidad",
  "datos",
  "comisiones",
  "puerta-staff",
] as const;

type FaqId = (typeof FAQ_IDS)[number];

function tabForHash(hash: string): Tab | null {
  const id = hash.replace(/^#/, "");
  if (TAB_IDS.includes(id as Tab)) return id as Tab;
  if (FAQ_IDS.includes(id as FaqId)) return "preguntas";
  return null;
}

function CopyAddressButton() {
  const { user } = usePollarAuth();
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (!user) {
    return <p className="text-xs text-muted">{t.guide.faq.usdcLoginFirst}</p>;
  }
  return (
    <Button
      variant="secondary"
      className="w-fit"
      onClick={() => {
        void navigator.clipboard.writeText(user.address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      <Icon name="copy" size={16} />
      {copied ? t.guide.faq.usdcCopied : t.guide.faq.usdcCopyAddress}
    </Button>
  );
}

function faqEntries(t: Dict): { id: FaqId; q: string; a: React.ReactNode }[] {
  const faq = t.guide.faq;
  return [
    {
      id: "usdc",
      q: faq.usdcQ,
      a: (
        <div className="flex flex-col gap-3">
          <p>{faq.usdcIntro}</p>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5">
            <li>{faq.usdcStep1}</li>
          </ol>
          <CopyAddressButton />
          <ol start={2} className="flex list-decimal flex-col gap-1.5 pl-5">
            <li>
              {faq.usdcStep2Before}{" "}
              <a
                href="https://faucet.circle.com"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-primary underline"
              >
                faucet.circle.com
              </a>
              .
            </li>
            <li>{faq.usdcStep3}</li>
            <li>{faq.usdcStep4}</li>
          </ol>
        </div>
      ),
    },
    { id: "usdc-que-es", q: faq.whatIsUsdcQ, a: faq.whatIsUsdcA },
    { id: "billetera", q: faq.walletQ, a: faq.walletA },
    {
      id: "pague-sin-entrada",
      q: faq.paidNoTicketQ,
      a: (
        <p>
          {faq.paidNoTicketBefore}{" "}
          <Link href="/mis-pases" className="font-semibold text-primary underline">
            {t.tickets.title}
          </Link>{" "}
          {faq.paidNoTicketAfter}
        </p>
      ),
    },
    { id: "reserva", q: faq.reservationQ, a: faq.reservationA },
    { id: "dos-veces", q: faq.screenshotQ, a: faq.screenshotA },
    { id: "reembolso", q: faq.refundQ, a: faq.refundA },
    { id: "privacidad", q: faq.privacyQ, a: faq.privacyA },
    { id: "datos", q: faq.dataQ, a: faq.dataA },
    {
      id: "comisiones",
      q: faq.feesQ,
      a: (
        <p>
          {faq.feesA.split("friendbot.stellar.org")[0]}
          <a
            href="https://friendbot.stellar.org"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-primary underline"
          >
            friendbot.stellar.org
          </a>
          {faq.feesA.split("friendbot.stellar.org")[1]}
        </p>
      ),
    },
    { id: "puerta-staff", q: faq.staffQ, a: faq.staffA },
  ];
}

export default function ComoFuncionaPage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("comprador");
  const [openFaq, setOpenFaq] = useState<string | null>(null);

  // Deep links: /como-funciona#usdc opens the FAQ tab on that question.
  useEffect(() => {
    function syncFromHash() {
      const hash = window.location.hash;
      const next = tabForHash(hash);
      if (!next) return;
      setTab(next);
      const id = hash.replace(/^#/, "");
      if (FAQ_IDS.includes(id as FaqId)) {
        setOpenFaq(id);
        requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
      }
    }
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: "comprador", label: t.guide.tabBuyer },
    { id: "organizador", label: t.guide.tabOrganizer },
    { id: "preguntas", label: t.guide.tabFaq },
  ];

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title={t.guide.title} back={{ href: "/app", label: t.common.home }} />

      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold tracking-tight">{t.guide.introTitle}</h2>
          <p className="text-sm leading-6 text-muted">{t.guide.introBody}</p>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {t.guide.flow.map((label, index) => (
            <div key={label} className="relative flex flex-col items-center gap-1.5 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-light text-primary">
                <Icon name={FLOW_ICONS[index]} size={20} />
              </span>
              <span className="text-xs font-semibold">{label}</span>
              {index < t.guide.flow.length - 1 && (
                <Icon name="chevron" size={14} className="absolute top-3.5 -right-2 text-muted-light" />
              )}
            </div>
          ))}
        </div>
      </Card>

      <div
        role="tablist"
        aria-label={t.guide.title}
        className="grid grid-cols-3 gap-1 rounded-2xl border border-border bg-surface p-1"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => {
              setTab(item.id);
              history.replaceState(null, "", `#${item.id}`);
            }}
            className={`rounded-xl px-2 py-2.5 text-sm font-semibold transition-colors ${
              tab === item.id ? "bg-background text-primary shadow-sm" : "text-muted hover:text-foreground"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "comprador" && (
        <Card className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-bold tracking-tight">{t.guide.buyerTitle}</h2>
            <p className="text-sm text-muted">{t.guide.buyerSubtitle}</p>
          </div>
          <GuideSteps steps={buyerSteps(t)} />
          <div className="flex flex-col gap-2 rounded-xl border border-warning-border bg-warning-light p-4 text-sm leading-6">
            <p className="font-semibold text-warning">{t.guide.zeroBalanceTitle}</p>
            <p className="text-foreground">
              {t.guide.zeroBalanceBody}{" "}
              <a href="#usdc" className="font-semibold text-primary underline">
                {t.guide.zeroBalanceLink}
              </a>
              .
            </p>
          </div>
          <Link
            href="/mis-pases"
            className="flex h-12 items-center justify-center gap-2 rounded-xl border border-primary/30 text-sm font-semibold text-primary transition-colors hover:bg-primary-light"
          >
            <Icon name="ticket" size={18} />
            {t.guide.seeTickets}
          </Link>
        </Card>
      )}

      {tab === "organizador" && (
        <Card className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-bold tracking-tight">{t.guide.organizerTitle}</h2>
            <p className="text-sm text-muted">{t.guide.organizerSubtitle}</p>
          </div>
          <GuideSteps steps={organizerSteps(t)} />
          <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4 text-sm leading-6">
            <Icon name="shield" size={20} className="mt-0.5 text-primary" />
            <p className="text-muted">
              <span className="font-semibold text-foreground">{t.guide.noOversellStrong}</span>{" "}
              {t.guide.noOversellBody}
            </p>
          </div>
          <Link
            href="/organizador/nuevo"
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover"
          >
            <Icon name="plus" size={18} />
            {t.guide.createCta}
          </Link>
        </Card>
      )}

      {tab === "preguntas" && (
        <div className="flex flex-col gap-2">
          {faqEntries(t).map((item) => (
            <details
              key={item.id}
              id={item.id}
              open={openFaq === item.id}
              onToggle={(e) => {
                const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                setOpenFaq((current) => (isOpen ? item.id : current === item.id ? null : current));
              }}
              className="group scroll-mt-4 rounded-2xl border border-border bg-background shadow-sm"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 font-semibold leading-6">
                {item.q}
                <Icon
                  name="chevron"
                  size={18}
                  className="text-muted transition-transform group-open:rotate-90"
                />
              </summary>
              <div className="px-5 pb-5 text-sm leading-6 text-muted">{item.a}</div>
            </details>
          ))}
        </div>
      )}
    </main>
  );
}
