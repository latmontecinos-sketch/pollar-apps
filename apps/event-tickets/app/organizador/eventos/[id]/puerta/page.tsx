"use client";

import { use, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { useT } from "@/lib/i18n/client";
import { AppHeader } from "@/components/AppHeader";
import { DoorScanner } from "@/components/DoorScanner";
import { Card } from "@/components/ui/Card";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";

/** Door mode in the organizer's own session. Staff use /puerta/[id] with the event's door link instead. */
export default function DoorModePage({
  params,
}: PageProps<"/organizador/eventos/[id]/puerta">) {
  const { id } = use(params);
  const { user, isLoading: authLoading } = usePollarAuth();
  const { getClient } = usePollar();
  const t = useT();
  const [denied, setDenied] = useState(false);

  if (authLoading) return null;

  const back = { href: `/organizador/eventos/${id}`, label: t.panel.title };

  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <AppHeader title={t.door.title} back={back} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PollarLogo size={64} />
          <p className="max-w-sm text-muted">{t.door.loginNote}</p>
          <LoginButton />
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title={t.door.title} back={back} />
      {denied ? (
        <Card className="flex flex-col gap-2 text-center">
          <p className="font-semibold text-error">{t.door.forbiddenTitle}</p>
          <p className="text-sm text-muted">{t.door.forbiddenBody}</p>
        </Card>
      ) : (
        <DoorScanner
          eventId={id}
          doorFetch={(path, init) => pollarFetch(getClient(), user.address, path, init)}
          onDenied={() => setDenied(true)}
        />
      )}
    </main>
  );
}
