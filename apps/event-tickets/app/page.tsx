import Link from "next/link";
import { ProductHeader } from "@/components/ProductHeader";
import { Icon } from "@/components/ui/Icon";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { getDict } from "@/lib/i18n/server";
import { IS_MAINNET } from "@/lib/network";

/** "solid" on the sheet; "light" is the white pill that reads on the brand band. */
function OpenApp({ label, tone = "solid" }: { label: string; tone?: "solid" | "light" }) {
  return (
    <Link
      href="/app"
      className={`flex h-12 items-center justify-center gap-2 rounded-full px-7 text-base font-semibold shadow-sm transition-all active:scale-[0.98] ${
        tone === "solid"
          ? "bg-primary text-primary-foreground hover:bg-primary-hover"
          : "bg-background text-primary hover:bg-primary-light"
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

  return (
    // .app-shell: the page sits on the sheet color, like every in-app screen.
    <div className="app-shell flex w-full flex-1 flex-col">
      {/* Hero: the brand band, with a lighter glow behind the headline. */}
      <section className="relative overflow-hidden bg-band pb-10 text-band-foreground">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-40 h-96 opacity-50 blur-3xl"
          style={{
            background:
              "radial-gradient(45% 60% at 50% 50%, var(--color-tile-mid) 0%, transparent 70%)",
          }}
        />
        <div className="relative mx-auto flex w-full max-w-3xl flex-col px-5">
          <ProductHeader />
          <div className="flex flex-col items-center gap-6 pb-16 pt-10 text-center sm:pt-16">
            <PollarLogo size={72} colorClass="bg-band-foreground" />
            <span className="rounded-full border border-band-foreground/25 bg-band-foreground/10 px-3 py-1 font-mono text-xs tracking-wide text-band-foreground/85">
              {t.product.badge}
            </span>
            <h1 className="max-w-2xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
              {t.product.heroTitle}
            </h1>
            <p className="max-w-xl text-base leading-7 text-band-foreground/80 sm:text-lg sm:leading-8">
              {t.product.heroSubtitle}
            </p>
            <div className="flex w-full max-w-xs flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center">
              <OpenApp label={t.product.openApp} tone="light" />
              <Link
                href="/como-funciona"
                className="flex h-12 items-center justify-center rounded-full border border-band-foreground/35 px-7 text-base font-semibold text-band-foreground transition-colors hover:bg-band-foreground/10"
              >
                {t.landing.seeHow}
              </Link>
            </div>
            <p className="text-xs text-band-foreground/70">
              {IS_MAINNET ? t.product.heroNoteLive : t.product.heroNote}
            </p>
          </div>
        </div>
      </section>

      {/* The sheet rides up over the band. How it works and how it's built live on /como-funciona. */}
      <div className="relative -mt-9 flex flex-1 flex-col rounded-t-[2.5rem] bg-sheet">
        <main className="mx-auto flex w-full max-w-3xl flex-col gap-14 px-5 pt-10 pb-14">
          <section className="grid gap-8 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted">
                <Icon name="alert" size={15} className="text-warning" />
                {t.product.problemTitle}
              </h2>
              <p className="text-base leading-7">{t.product.problemBody}</p>
            </div>
            <div className="flex flex-col gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-primary-text">
                <Icon name="ticket" size={15} />
                {t.product.solutionTitle}
              </h2>
              <p className="text-base leading-7">{t.product.solutionBody}</p>
            </div>
          </section>

          <section className="grid gap-8 sm:grid-cols-2">
            <div className="flex flex-col gap-2 border-t border-border pt-5">
              <h2 className="flex items-center gap-2 font-bold">
                <Icon name="calendar" size={18} className="text-primary-text" />
                {t.product.audienceOrganizerTitle}
              </h2>
              <p className="text-sm leading-6 text-muted">{t.product.audienceOrganizerBody}</p>
            </div>
            <div className="flex flex-col gap-2 border-t border-border pt-5">
              <h2 className="flex items-center gap-2 font-bold">
                <Icon name="ticket" size={18} className="text-primary-text" />
                {t.product.audienceBuyerTitle}
              </h2>
              <p className="text-sm leading-6 text-muted">{t.product.audienceBuyerBody}</p>
            </div>
          </section>
        </main>

        <section className="mx-auto w-full max-w-3xl px-5 pb-12">
          <div className="flex flex-col items-center gap-5 rounded-[2rem] bg-band px-6 py-12 text-center text-band-foreground shadow-md">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{t.product.ctaTitle}</h2>
            <p className="max-w-md text-base leading-7 text-band-foreground/80">{t.product.ctaBody}</p>
            <OpenApp label={t.product.openApp} tone="light" />
          </div>
        </section>
      </div>
    </div>
  );
}
