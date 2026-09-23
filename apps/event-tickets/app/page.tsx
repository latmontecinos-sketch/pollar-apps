import Link from "next/link";
import { buyerSteps, GuideSteps } from "@/components/GuideSteps";
import { ProductHeader } from "@/components/ProductHeader";
import { Icon, type IconName } from "@/components/ui/Icon";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { getDict } from "@/lib/i18n/server";
import { IS_MAINNET } from "@/lib/network";

const FEATURE_ICONS: IconName[] = ["wallet", "shield", "share", "users", "clock", "settings"];
const REPO_URL = "https://github.com/pollar-xyz/pollar-apps/pull/32";

/** The three numbers that say what this is, before any prose. */
const STATS: { value: string; icon: IconName }[] = [
  { value: "USDC", icon: "wallet" },
  { value: "10 min", icon: "clock" },
  { value: "1 QR", icon: "qr" },
];

function OpenApp({ label, tone = "solid" }: { label: string; tone?: "solid" | "ghost" }) {
  return (
    <Link
      href="/app"
      className={`flex h-12 items-center justify-center gap-2 rounded-xl px-7 text-base font-semibold transition-colors ${
        tone === "solid"
          ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover"
          : "border border-border text-foreground hover:bg-surface"
      }`}
    >
      {label}
      <Icon name="chevron" size={18} />
    </Link>
  );
}

/**
 * Public product page: what Pollar Pass is, for someone who landed here
 * from a link or a pitch — the app itself lives at /app. Server-rendered
 * in the reader's language, so it's shareable and indexable as-is.
 *
 * Layout follows the "minimal single column" landing pattern: one loud
 * headline, one primary action repeated at top and bottom, hairline
 * sections instead of card soup, and no nav clutter.
 */
export default async function ProductPage() {
  const { t } = await getDict();
  const statLabels = [t.product.stats.currency, t.product.stats.hold, t.product.stats.entry];

  return (
    <div className="flex w-full flex-1 flex-col">
      {/* Hero: dark-tinted band with a soft brand glow behind the headline. */}
      <section className="relative overflow-hidden border-b border-border bg-surface">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-40 h-96 opacity-60 blur-3xl"
          style={{
            background:
              "radial-gradient(45% 60% at 50% 50%, var(--color-primary) 0%, transparent 70%)",
          }}
        />
        <div className="relative mx-auto flex w-full max-w-3xl flex-col px-5">
          <ProductHeader />
          <div className="flex flex-col items-center gap-6 pb-16 pt-10 text-center sm:pt-16">
            <PollarLogo size={72} />
            <span className="rounded-full border border-border bg-background/70 px-3 py-1 font-mono text-xs tracking-wide text-muted">
              {t.product.badge}
            </span>
            <h1 className="max-w-2xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
              {t.product.heroTitle}
            </h1>
            <p className="max-w-xl text-base leading-7 text-muted sm:text-lg sm:leading-8">
              {t.product.heroSubtitle}
            </p>
            <div className="flex w-full max-w-xs flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center">
              <OpenApp label={t.product.openApp} />
              <Link
                href="/como-funciona"
                className="flex h-12 items-center justify-center rounded-xl border border-border px-7 text-base font-semibold text-foreground transition-colors hover:bg-background"
              >
                {t.landing.seeHow}
              </Link>
            </div>
            <p className="text-xs text-muted-light">
              {IS_MAINNET ? t.product.heroNoteLive : t.product.heroNote}
            </p>
          </div>
        </div>
      </section>

      {/* Stat strip: the whole model in three numbers. */}
      <section className="border-b border-border">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-3 divide-x divide-border px-5">
          {STATS.map((stat, index) => (
            <div key={stat.value} className="flex flex-col items-center gap-1 py-6 text-center">
              <Icon name={stat.icon} size={16} className="text-primary" />
              <span className="font-mono text-xl font-bold tracking-tight sm:text-2xl">
                {stat.value}
              </span>
              <span className="px-2 text-xs leading-4 text-muted">{statLabels[index]}</span>
            </div>
          ))}
        </div>
      </section>

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-20 px-5 py-16">
        <section className="grid gap-8 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted">
              <Icon name="alert" size={15} className="text-warning" />
              {t.product.problemTitle}
            </h2>
            <p className="text-base leading-7">{t.product.problemBody}</p>
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-primary">
              <Icon name="ticket" size={15} />
              {t.product.solutionTitle}
            </h2>
            <p className="text-base leading-7">{t.product.solutionBody}</p>
          </div>
        </section>

        <section className="flex flex-col gap-8">
          <h2 className="text-3xl font-bold tracking-tight">{t.product.featuresTitle}</h2>
          <div className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {t.product.features.map((feature, index) => (
              <div key={feature.title} className="flex flex-col gap-2 border-t border-border pt-5">
                <Icon name={FEATURE_ICONS[index]} size={20} className="text-primary" />
                <h3 className="font-semibold leading-6">{feature.title}</h3>
                <p className="text-sm leading-6 text-muted">{feature.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-8">
          <h2 className="text-3xl font-bold tracking-tight">{t.product.stepsTitle}</h2>
          <div className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
            <GuideSteps steps={buyerSteps(t)} />
          </div>
        </section>

        <section className="grid gap-8 sm:grid-cols-2">
          <div className="flex flex-col gap-2 border-t border-border pt-5">
            <h2 className="flex items-center gap-2 font-bold">
              <Icon name="calendar" size={18} className="text-primary" />
              {t.product.audienceOrganizerTitle}
            </h2>
            <p className="text-sm leading-6 text-muted">{t.product.audienceOrganizerBody}</p>
          </div>
          <div className="flex flex-col gap-2 border-t border-border pt-5">
            <h2 className="flex items-center gap-2 font-bold">
              <Icon name="ticket" size={18} className="text-primary" />
              {t.product.audienceBuyerTitle}
            </h2>
            <p className="text-sm leading-6 text-muted">{t.product.audienceBuyerBody}</p>
          </div>
        </section>

        <section className="flex flex-col gap-4 border-t border-border pt-6">
          <h2 className="flex items-center gap-2 font-bold">
            <Icon name="shield" size={18} className="text-primary" />
            {t.product.techTitle}
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-muted">{t.product.techBody}</p>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold text-primary">
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5">
              {t.product.linkRepo} <Icon name="external" size={13} />
            </a>
            <Link href="/como-funciona" className="flex items-center gap-1.5">
              {t.product.linkGuide} <Icon name="chevron" size={13} />
            </Link>
          </div>
        </section>
      </main>

      <section className="border-t border-border bg-surface">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-5 px-5 py-16 text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{t.product.ctaTitle}</h2>
          <p className="max-w-md text-base leading-7 text-muted">{t.product.ctaBody}</p>
          <OpenApp label={t.product.openApp} />
        </div>
      </section>
    </div>
  );
}
