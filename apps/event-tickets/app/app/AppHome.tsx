"use client";

import { useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { EventShowcase } from "@/components/EventShowcase";
import { BalanceCard } from "@/components/BalanceCard";
import { buyerSteps, GuideSteps } from "@/components/GuideSteps";
import { LoginButton } from "@/components/LoginButton";
import { CreateEventButton, OrganizerEventCard } from "@/components/OrganizerEventCard";
import { ReceiveModal } from "@/components/ReceiveModal";
import { WelcomeGiftCard } from "@/components/WelcomeGiftCard";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { IconTile, ListRow } from "@/components/ui/ListRow";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";
import { Stat } from "@/components/ui/Stat";
import { useAppMode } from "@/hooks/useAppMode";
import { useBalance } from "@/hooks/useBalance";
import { useMyEvents } from "@/hooks/useMyEvents";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import type { AppMode } from "@/lib/app-mode";
import { formatAmount, salesClosed } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { decimalToStroops, stroopsToDecimal } from "@/lib/money";
import type { PublicEvent } from "@/lib/public-events";

/** Signed out, inside the app: what's on first, then a short way in. */
function SignedOut({ events }: { events: PublicEvent[] }) {
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
      <EventShowcase events={events} />

      <div className="flex flex-col items-center gap-3 pt-2 text-center">
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

/** The switch at the top of either home: the other mode is one tap away. */
function ModeSwitch({ mode, onChange }: { mode: AppMode; onChange: (mode: AppMode) => void }) {
  const t = useT();
  return (
    <Segmented
      label={t.mode.label}
      value={mode}
      onChange={onChange}
      options={[
        { value: "explore", label: t.mode.explore },
        { value: "organize", label: t.mode.organize },
      ]}
    />
  );
}

/** First visit after signing in: pick how to use the app. The choice sticks, and the switch stays on the home. */
function ModeChooser({ onChoose }: { onChoose: (mode: AppMode) => void }) {
  const t = useT();
  const choices = [
    { mode: "explore" as const, icon: "search" as const, title: t.mode.explore, body: t.mode.exploreBody },
    { mode: "organize" as const, icon: "calendar" as const, title: t.mode.organize, body: t.mode.organizeBody },
  ];
  return (
    <AppShell
      hero={
        <section className="flex flex-col items-center gap-3 pt-2 text-center">
          <PollarLogo size={56} colorClass="bg-band-foreground" />
          <h1 className="text-2xl font-extrabold leading-tight tracking-tight">{t.mode.chooseTitle}</h1>
          <p className="max-w-sm text-sm text-band-foreground/80">{t.mode.chooseSubtitle}</p>
        </section>
      }
    >
      {choices.map((choice) => (
        <button
          key={choice.mode}
          type="button"
          onClick={() => onChoose(choice.mode)}
          className="flex items-center gap-4 rounded-3xl border border-border/70 bg-background p-5 text-left shadow-sm transition-all hover:border-primary/40 active:scale-[0.99]"
        >
          <IconTile icon={choice.icon} tone={choice.mode === "explore" ? "strong" : "mid"} size={56} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-lg font-bold tracking-tight">{choice.title}</span>
            <span className="text-sm leading-6 text-muted">{choice.body}</span>
          </span>
          <Icon name="chevron" size={20} className="shrink-0 text-muted-light" />
        </button>
      ))}
    </AppShell>
  );
}

/**
 * Organizer mode: what's on sale, what sold and what it brought in on the
 * band; then creating an event, the next few events, and the door.
 */
function OrganizerHome({ onMode }: { onMode: (mode: AppMode) => void }) {
  const t = useT();
  const locale = useLocale();
  const state = useMyEvents();
  const events = state.step === "loaded" ? state.events : [];
  const upcoming = events
    .filter((event) => !salesClosed(event.datetimeUtc))
    .sort((a, b) => a.datetimeUtc.localeCompare(b.datetimeUtc));
  const sold = events.reduce((sum, event) => sum + event.paid, 0);
  const collected = stroopsToDecimal(
    events.reduce((sum, event) => sum + decimalToStroops(event.collectedDecimal), 0n)
  );
  const figure = (value: string | number) => (state.step === "loaded" ? value : "–");

  return (
    <AppShell
      title={t.mode.organizerTitle}
      subtitle={t.mode.organizerSubtitle}
      hero={
        <div className="grid grid-cols-3 gap-2">
          <Stat icon="calendar" label={t.mode.statOnSale} value={figure(upcoming.length)} />
          <Stat icon="ticket" label={t.mode.statSold} value={figure(sold)} />
          <Stat icon="wallet" label={t.mode.statCollected} value={figure(formatAmount(collected, locale))} />
        </div>
      }
    >
      <ModeSwitch mode="organize" onChange={onMode} />
      <CreateEventButton label={t.home.createTile} />

      <div className="flex items-baseline justify-between px-1 pt-2">
        <h2 className="text-lg font-bold tracking-tight">{t.mode.upcoming}</h2>
        {events.length > 0 && (
          <Link href="/mis-eventos" className="text-sm font-semibold text-primary-text hover:underline">
            {t.mode.seeAll}
          </Link>
        )}
      </div>
      {state.step === "loading" && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}
      {state.step === "error" && <p className="px-1 text-sm text-error">{t.myEvents.loadError}</p>}
      {state.step === "loaded" && upcoming.length === 0 && (
        <p className="px-1 text-sm leading-6 text-muted">{t.mode.noUpcoming}</p>
      )}
      {upcoming.slice(0, 3).map((event) => (
        <OrganizerEventCard key={event.id} event={event} />
      ))}

      <h2 className="px-1 pt-2 text-lg font-bold tracking-tight">{t.mode.tools}</h2>
      <nav className="flex flex-col gap-1">
        <ListRow
          href="/mis-eventos"
          icon="calendar"
          tone="strong"
          title={t.home.eventsTile}
          subtitle={t.home.eventsTileBody}
        />
        <ListRow href="/escanear" icon="scan" tone="mid" title={t.scan.open} subtitle={t.scan.body} />
      </nav>
      {state.step === "loaded" && decimalToStroops(collected) > 0n && (
        <p className="px-1 text-xs leading-5 text-muted">{t.mode.collectedNote(formatAmount(collected, locale))}</p>
      )}
    </AppShell>
  );
}

/** The two quick actions under the balance: light pills on the band. */
const bandPill =
  "flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-background text-sm font-semibold text-foreground shadow-sm transition-all hover:text-primary active:scale-[0.98]";

/**
 * Looking-for-events mode: balance on the band; then the welcome gift, the
 * showcase of public events, and the tickets already bought.
 */
function ExploreHome({ events, onMode }: { events: PublicEvent[]; onMode: (mode: AppMode) => void }) {
  const { balance, isLoading } = useBalance();
  const [receiveOpen, setReceiveOpen] = useState(false);
  const t = useT();

  const emptyBalance = !isLoading && balance !== null && Number(balance) < 0.01;

  return (
    <AppShell
      title={t.home.greeting}
      subtitle={t.mode.exploreTitle}
      hero={
        <div className="flex flex-col gap-4">
          <BalanceCard />
          <div className="flex gap-2">
            <button onClick={() => setReceiveOpen(true)} className={bandPill}>
              <Icon name="wallet" size={17} className="text-primary-text" />
              {t.home.receive}
            </button>
            <Link href="/como-funciona#usdc" className={bandPill}>
              <Icon name="plus" size={17} className="text-primary-text" />
              {t.home.testUsdc}
            </Link>
          </div>
        </div>
      }
    >
      <ModeSwitch mode="explore" onChange={onMode} />
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

      <EventShowcase events={events} />

      <h2 className="px-1 pt-2 text-lg font-bold tracking-tight">{t.showcase.myArea}</h2>
      <nav className="flex flex-col gap-1">
        <ListRow
          href="/mis-pases"
          icon="ticket"
          tone="strong"
          title={t.home.ticketsTile}
          subtitle={t.home.ticketsTileBody}
        />
      </nav>

      <Link
        href="/como-funciona"
        className="flex items-center gap-3 rounded-3xl border border-dashed border-tile-soft p-4 text-sm transition-colors hover:border-primary/40 hover:bg-background"
      >
        <Icon name="help" size={20} className="text-primary-text" />
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

/**
 * The app's own home. Signed out: the showcase and a way in. Signed in: the
 * mode chooser the first time, then the home of the chosen mode — looking
 * for events or organizing them — with a switch between the two.
 */
export function AppHome({ events, initialMode }: { events: PublicEvent[]; initialMode: AppMode | null }) {
  const { user } = usePollarAuth();
  const [mode, setMode] = useAppMode(initialMode);

  if (!user) return <SignedOut events={events} />;
  if (!mode) return <ModeChooser onChoose={setMode} />;
  return mode === "organize" ? <OrganizerHome onMode={setMode} /> : <ExploreHome events={events} onMode={setMode} />;
}
