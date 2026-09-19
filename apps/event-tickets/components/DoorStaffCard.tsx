"use client";

import { useState, useSyncExternalStore } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
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
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => "");
  const [token, setToken] = useState(initialToken);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = token && origin ? `${origin}/puerta/${eventId}#t=${token}` : "";

  async function change(method: "POST" | "DELETE") {
    if (!user) return;
    if (method === "DELETE" && !confirm("¿Desactivar el link? Quien lo tenga ya no podrá validar entradas.")) return;
    if (method === "POST" && token && !confirm("¿Crear un link nuevo? El anterior dejará de funcionar.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await pollarFetch(getClient(), user.address, `/api/events/${eventId}/door-link`, { method });
      const data = (await res.json()) as { doorToken?: string | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? "No se pudo actualizar el link");
      setToken(data.doorToken ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo salió mal");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const message = `Link para validar entradas en la puerta de "${eventName}" (no lo compartas con nadie más): ${link}`;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-bold">
          <Icon name="users" size={18} className="text-primary" />
          Personal de puerta
        </h2>
        <p className="text-sm leading-6 text-muted">
          ¿Alguien más va a recibir a la gente? Mándale un link que solo sirve para escanear entradas
          de este evento — no ve tus ventas ni tu cuenta.
        </p>
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
              {copied ? "Copiado" : "Copiar"}
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
              Enviar
            </a>
            <Button variant="ghost" loading={busy} onClick={() => void change("DELETE")}>
              Desactivar
            </Button>
          </div>
          <button
            onClick={() => void change("POST")}
            disabled={busy}
            className="text-xs font-semibold text-muted underline hover:text-primary"
          >
            Crear un link nuevo (anula el actual)
          </button>
        </>
      ) : (
        <Button variant="secondary" loading={busy} onClick={() => void change("POST")}>
          <Icon name="scan" size={17} />
          Crear link para el personal
        </Button>
      )}

      {error && (
        <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">{error}</p>
      )}
    </Card>
  );
}
