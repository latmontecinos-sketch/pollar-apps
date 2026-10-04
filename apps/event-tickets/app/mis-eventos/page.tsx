"use client";

import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useMyEvents } from "@/hooks/useMyEvents";
import { useT } from "@/lib/i18n/client";
import { AppShell } from "@/components/AppShell";
import { ScreenLoading } from "@/components/ScreenLoading";
import { CreateEventButton, OrganizerEventCard } from "@/components/OrganizerEventCard";
import { Card } from "@/components/ui/Card";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoginButton } from "@/components/LoginButton";
import { PassLogo } from "@/components/ui/PassLogo";
import { Spinner } from "@/components/ui/Spinner";

export default function MisEventosPage() {
  const { user, isLoading: authLoading } = usePollarAuth();
  const t = useT();
  const state = useMyEvents();

  if (authLoading) return <ScreenLoading title={t.myEvents.title} back={{ href: "/app", label: t.common.home }} />;

  if (!user) {
    return (
      <AppShell title={t.myEvents.title} back={{ href: "/app", label: t.common.home }}>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PassLogo size={64} layout="stacked" />
          <p className="max-w-sm text-muted">{t.myEvents.loginNote}</p>
          <LoginButton />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title={t.myEvents.title} back={{ href: "/app", label: t.common.home }}>
      {state.step === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {state.step === "error" && <LoadError message={t.myEvents.loadError} onRetry={state.retry} />}

      {state.step === "loaded" && state.events.length === 0 && (
        <Card>
          <EmptyState
            title={t.myEvents.emptyTitle}
            description={t.myEvents.emptyBody}
            action={<CreateEventButton label={t.myEvents.create} />}
          />
        </Card>
      )}

      {state.step === "loaded" && state.events.length > 0 && (
        <>
          <CreateEventButton label={t.myEvents.create} />
          {state.events.map((event) => (
            <OrganizerEventCard key={event.id} event={event} />
          ))}
        </>
      )}
    </AppShell>
  );
}
