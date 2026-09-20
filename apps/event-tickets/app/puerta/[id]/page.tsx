"use client";

import { use, useState, useSyncExternalStore } from "react";
import { DoorScanner } from "@/components/DoorScanner";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { useT } from "@/lib/i18n/client";

const DOOR_TOKEN_HEADER = "x-door-token";

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** `#t=…` from the URL fragment: never sent to the server with the page request. */
function readToken(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get("t") ?? "";
}

/**
 * Staff door mode: no Pollar login, just the link the organizer shared
 * (/puerta/[id]#t=…). The token only unlocks check-in for this one event,
 * and the organizer can revoke it from their panel at any time.
 */
export default function StaffDoorPage({ params }: PageProps<"/puerta/[id]">) {
  const { id } = use(params);
  const t = useT();
  const token = useSyncExternalStore(subscribeToHash, readToken, () => null);
  const [denied, setDenied] = useState<string | null>(null);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <header className="flex items-center justify-between gap-3 py-2">
        <div className="flex items-center gap-2.5">
          <PollarLogo size={30} />
          <h1 className="text-xl font-bold tracking-tight">{t.staff.pageTitle}</h1>
        </div>
        <span className="flex items-center gap-1.5 rounded-full bg-primary-light px-3 py-1 text-xs font-semibold text-primary">
          <Icon name="users" size={14} /> {t.staff.badge}
        </span>
      </header>

      {token === null ? null : !token || denied ? (
        <Card className="flex flex-col items-center gap-2 text-center">
          <Icon name="alert" size={28} className="text-error" />
          <p className="font-semibold">{t.staff.invalidTitle}</p>
          <p className="text-sm text-muted">
            {denied || t.staff.missingToken} {t.staff.invalidBody}
          </p>
        </Card>
      ) : (
        <DoorScanner
          eventId={id}
          doorFetch={(path, init) =>
            fetch(path, {
              ...init,
              headers: { "Content-Type": "application/json", [DOOR_TOKEN_HEADER]: token },
            })
          }
          onDenied={setDenied}
        />
      )}
    </main>
  );
}
