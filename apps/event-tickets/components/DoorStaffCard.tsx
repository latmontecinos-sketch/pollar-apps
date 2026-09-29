"use client";

import { useState, useSyncExternalStore } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";

const noopSubscribe = () => () => {};

/**
 * Lets the organizer hand door duty to someone else without sharing their
 * account: a secret link that only opens check-in for this event. The
 * token rides in the URL *fragment* (#t=…), so it never reaches server
 * logs or a Referer header; replacing or revoking it kills the old link.
 */
export function DoorStaffCard({
  eventId,
  eventName,
  initialToken,
}: {
  eventId: string;
  eventName: string;
  initialToken: string | null;
}) {
  const { user } = usePollarAuth();
  const { getClient } = usePollar();
  const t = useT();
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => "");
  const [token, setToken] = useState(initialToken);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = token && origin ? `${origin}/puerta/${eventId}#t=${token}` : "";

  async function change(method: "POST" | "DELETE") {
    if (!user) return;
    if (method === "DELETE" && !confirm(t.staff.confirmDisable)) return;
    if (method === "POST" && token && !confirm(t.staff.confirmRegenerate)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await pollarFetch(getClient(), user.address, `/api/events/${eventId}/door-link`, { method });
      const data = (await res.json()) as { doorToken?: string | null; error?: string; code?: string };
      if (!res.ok) throw new Error(apiErrorMessage(t, data, t.staff.error));
      setToken(data.doorToken ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.staff.error);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const message = t.staff.message(eventName, link);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-bold">
          <Icon name="users" size={18} className="text-primary" />
          {t.staff.cardTitle}
        </h2>
        <p className="text-sm leading-6 text-muted">{t.staff.cardBody}</p>
      </div>

      {token ? (
        <>
          <button
            onClick={() => void copy()}
            className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-hover"
          >
            <span className="min-w-0 truncate font-mono text-xs">{link || "…"}</span>
            <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-primary">
              <Icon name={copied ? "check" : "copy"} size={16} />
              {copied ? t.common.copied : t.common.copy}
            </span>
          </button>
          <div className="grid grid-cols-2 gap-2">
            <a
              href={`https://wa.me/?text=${encodeURIComponent(message)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 rounded-xl border border-primary/30 px-3 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary-light"
            >
              <Icon name="message" size={16} />
              {t.staff.send}
            </a>
            <Button variant="ghost" loading={busy} onClick={() => void change("DELETE")}>
              {t.staff.disable}
            </Button>
          </div>
          <button
            onClick={() => void change("POST")}
            disabled={busy}
            className="text-xs font-semibold text-muted underline hover:text-primary"
          >
            {t.staff.regenerate}
          </button>
        </>
      ) : (
        <Button variant="secondary" loading={busy} onClick={() => void change("POST")}>
          <Icon name="scan" size={17} />
          {t.staff.create}
        </Button>
      )}

      {error && (
        <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">{error}</p>
      )}
    </Card>
  );
}
