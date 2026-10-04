"use client";

import { AppShell } from "@/components/AppShell";
import { ScreenLoading } from "@/components/ScreenLoading";
import { LoadError } from "@/components/LoadError";
import { LoginButton } from "@/components/LoginButton";
import { CreateEventButton } from "@/components/OrganizerEventCard";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListRow } from "@/components/ui/ListRow";
import { PassLogo } from "@/components/ui/PassLogo";
import { Spinner } from "@/components/ui/Spinner";
import { useMyEvents } from "@/hooks/useMyEvents";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { formatEventDateTime, salesClosed } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";

/**
 * The organizer's "Puerta" tab: pick which event to check in, then land on
 * its door (`/organizador/eventos/[id]/puerta`). Events still on sale come
 * first; finished ones stay below, since a door can run past the start time.
 */
export default function DoorPickerPage() {
  const { user, isLoading: authLoading } = usePollarAuth();
  const t = useT();
  const locale = useLocale();
  const state = useMyEvents();
  const back = { href: "/app", label: t.common.home };

  if (authLoading) return <ScreenLoading title={t.door.pickTitle} back={back} />;

  if (!user) {
    return (
      <AppShell title={t.door.pickTitle} back={back}>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PassLogo size={64} layout="stacked" />
          <p className="max-w-sm text-muted">{t.door.loginNote}</p>
          <LoginButton />
        </div>
      </AppShell>
    );
  }

  const events = state.step === "loaded" ? state.events : [];
  const ordered = [
    ...events.filter((event) => !salesClosed(event.datetimeUtc)),
    ...events.filter((event) => salesClosed(event.datetimeUtc)),
  ];

  return (
    <AppShell title={t.door.pickTitle} back={back}>
      <p className="px-1 text-sm leading-6 text-muted">{t.door.pickBody}</p>

      {state.step === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {state.step === "error" && <LoadError message={t.myEvents.loadError} onRetry={state.retry} />}

      {state.step === "loaded" && events.length === 0 && (
        <Card>
          <EmptyState
            title={t.myEvents.emptyTitle}
            description={t.myEvents.emptyBody}
            action={<CreateEventButton label={t.myEvents.create} />}
          />
        </Card>
      )}

      {ordered.length > 0 && (
        <nav className="flex flex-col gap-1">
          {ordered.map((event) => (
            <ListRow
              key={event.id}
              href={`/organizador/eventos/${event.id}/puerta`}
              icon="scan"
              tone="mid"
              title={event.name}
              subtitle={`${formatEventDateTime(event.datetimeUtc, locale)} · ${event.place}`}
            />
          ))}
        </nav>
      )}
    </AppShell>
  );
}
