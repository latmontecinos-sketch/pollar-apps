"use client";

import { use, useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { Spinner } from "@/components/ui/Spinner";

type EventDetails = {
  id: string;
  organizerPollarId: string;
  name: string;
  description: string;
  datetimeUtc: string;
  place: string;
  priceDecimal: string;
  capacity: number;
  reserved: number;
};

type LoadState =
  | { step: "loading" }
  | { step: "forbidden" }
  | { step: "not_found" }
  | { step: "loaded"; event: EventDetails };

export default function OrganizerEventPage({
  params,
}: PageProps<"/organizador/eventos/[id]">) {
  const { id } = use(params);
  const { user, isLoading: authLoading } = usePollarAuth();
  // `usePollar()` hands back a fresh object every render, so its identity
  // can't sit in a dependency array without retriggering the effect forever.
  // The underlying client is a single global singleton either way (see
  // lib/pollar.tsx), so reading it through a ref is safe and stable.
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });

  const [state, setState] = useState<LoadState>({ step: "loading" });
  const [form, setForm] = useState({ name: "", description: "", place: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // `usePollarAuth()` builds a new `user` object every render, so depending
  // on `user` itself would refire this on every render forever — depend on
  // the stable primitive (the address) instead.
  const address = user?.address;
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      const client = pollarRef.current.getClient();
      // Sweep first so the numbers below (vendidos/cupo) already reflect any
      // seats released by sales whose payment window expired.
      await pollarFetch(client, address, `/api/events/${id}/sweep`, { method: "POST" });
      if (cancelled) return;
      const res = await pollarFetch(client, address, `/api/events/${id}`);
      if (cancelled) return;
      if (res.status === 404) return setState({ step: "not_found" });
      if (res.status === 403 || res.status === 401) return setState({ step: "forbidden" });
      const event = (await res.json()) as EventDetails;
      setForm({ name: event.name, description: event.description, place: event.place });
      setState({ step: "loaded", event });
    })();
    return () => {
      cancelled = true;
    };
  }, [address, id]);

  if (authLoading) return null;

  if (!user) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-12 text-center">
        <PollarLogo size={72} />
        <p className="max-w-sm text-muted">
          Iniciá sesión con la cuenta organizadora para ver este panel.
        </p>
        <LoginButton />
      </main>
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      const res = await pollarFetch(pollar.getClient(), user!.address, `/api/events/${id}`, {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      const data = (await res.json()) as EventDetails & { error?: string };
      if (!res.ok) {
        setSaveError(data.error ?? "No se pudo guardar");
        return;
      }
      setState({ step: "loaded", event: data });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Algo salió mal");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <header className="flex items-center gap-2.5 py-2">
        <PollarLogo size={28} />
        <h1 className="text-xl font-bold tracking-tight">Panel del evento</h1>
      </header>

      {state.step === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {state.step === "not_found" && (
        <Card>
          <p className="text-center text-sm text-muted">Ese evento no existe.</p>
        </Card>
      )}

      {state.step === "forbidden" && (
        <Card>
          <p className="text-center text-sm text-error">
            Esta cuenta no es la organizadora de este evento (403).
          </p>
        </Card>
      )}

      {state.step === "loaded" && (
        <>
          <Card className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Vendidos / cupo</span>
              <span className="font-mono font-semibold">
                {state.event.reserved} / {state.event.capacity}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Precio</span>
              <span className="font-mono font-semibold">
                {state.event.priceDecimal} USDC
              </span>
            </div>
            <a
              href={`/e/${state.event.id}`}
              className="mt-1 text-sm font-medium text-primary underline"
            >
              Ver página pública →
            </a>
            <a
              href={`/organizador/eventos/${state.event.id}/puerta`}
              className="text-sm font-medium text-primary underline"
            >
              Modo puerta →
            </a>
          </Card>

          <Card>
            <form onSubmit={save} className="flex flex-col gap-4">
              <Input
                label="Nombre"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              <Input
                label="Descripción"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
              <Input
                label="Lugar"
                value={form.place}
                onChange={(e) => setForm((f) => ({ ...f, place: e.target.value }))}
              />
              {saveError && (
                <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
                  {saveError}
                </p>
              )}
              <Button type="submit" loading={saving}>
                Guardar cambios
              </Button>
            </form>
          </Card>
        </>
      )}
    </main>
  );
}
