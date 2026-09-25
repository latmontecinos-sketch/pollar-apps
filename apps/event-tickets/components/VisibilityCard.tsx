"use client";

import { useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { useT } from "@/lib/i18n/client";

/**
 * Who can find the event, as the organizer sees it: listed in the showcase,
 * private behind its code, or (events from before this existed) link-only.
 * Switching is one PATCH; going private again keeps the same code, so links
 * already shared keep working.
 */
export function VisibilityCard({
  eventId,
  visibility,
  accessCode,
  onChanged,
}: {
  eventId: string;
  visibility: string;
  accessCode: string | null;
  /** The event as the PATCH returns it. */
  onChanged: (event: unknown) => void;
}) {
  const t = useT();
  const { user } = usePollarAuth();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function change(next: "public" | "private") {
    if (!user) return;
    setBusy(true);
    setError(false);
    try {
      const res = await pollarFetch(pollarRef.current.getClient(), user.address, `/api/events/${eventId}`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: next }),
      });
      if (!res.ok) return setError(true);
      onChanged(await res.json());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const label =
    visibility === "public" ? t.visibility.public : visibility === "private" ? t.visibility.private : t.visibility.link;
  const body =
    visibility === "public"
      ? t.visibility.publicBody
      : visibility === "private"
        ? t.visibility.privateBody
        : t.visibility.linkBody;

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-bold">
        <Icon name={visibility === "private" ? "shield" : "users"} size={18} className="text-primary-text" />
        {t.visibility.title}
      </h2>
      <p className="text-sm">
        <span className="font-semibold">{label}.</span> <span className="text-muted">{body}</span>
      </p>
      {visibility === "private" && accessCode && (
        <div className="flex flex-col gap-1 rounded-2xl bg-field px-4 py-3">
          <span className="text-xs text-muted">{t.visibility.code}</span>
          <span className="font-mono text-xl font-bold tracking-[0.3em]">{accessCode}</span>
          <span className="text-xs leading-5 text-muted">{t.visibility.codeHint}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {visibility !== "public" && (
          <Button variant="secondary" loading={busy} onClick={() => void change("public")} className="px-4 py-2 text-xs">
            {t.visibility.makePublic}
          </Button>
        )}
        {visibility !== "private" && (
          <Button variant="secondary" loading={busy} onClick={() => void change("private")} className="px-4 py-2 text-xs">
            {t.visibility.makePrivate}
          </Button>
        )}
      </div>
      {error && (
        <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-xs text-error" role="alert">
          {t.visibility.saveError}
        </p>
      )}
    </Card>
  );
}
