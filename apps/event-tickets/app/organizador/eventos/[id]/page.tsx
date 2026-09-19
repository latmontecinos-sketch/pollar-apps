"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import {
  formatAmount,
  formatEventDateTime,
  laPazLocalToUtcIso,
  salesClosed,
  utcIsoToLaPazLocal,
} from "@/lib/format";
import { decimalToStroops, stroopsToDecimal } from "@/lib/money";
import { AppHeader } from "@/components/AppHeader";
import { DoorStaffCard } from "@/components/DoorStaffCard";
import { ShareEventCard } from "@/components/ShareEventCard";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";
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
  paid: number;
  checkedIn: number;
  organizerName: string;
  organizerContact: string;
  doorToken: string | null;
};

type LoadState =
  | { step: "loading" }
  | { step: "forbidden" }
  | { step: "not_found" }
  | { step: "loaded"; event: EventDetails };

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-surface p-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="font-mono text-lg font-semibold">{value}</span>
      {hint && <span className="text-[11px] leading-4 text-muted-light">{hint}</span>}
    </div>
  );
}

function ActionLink({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: IconName;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-2xl border border-border bg-background p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-primary-light"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-light text-primary">
        <Icon name={icon} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold">{title}</span>
        <span className="text-sm text-muted">{description}</span>
      </span>
      <Icon name="chevron" size={18} className="text-muted-light" />
    </Link>
  );
}

export default function OrganizerEventPage({
  params,
  searchParams,
}: PageProps<"/organizador/eventos/[id]">) {
  const { id } = use(params);
  const justCreated = use(searchParams).nuevo === "1";
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
  const [form, setForm] = useState({
    name: "",
    description: "",
    place: "",
    datetimeLocal: "",
    organizerName: "",
    organizerContact: "",
  });
  const [editing, setEditing] = useState(false);
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
      // Sweep first so the numbers below already reflect any seats released
      // by sales whose payment window expired.
      await pollarFetch(client, address, `/api/events/${id}/sweep`, { method: "POST" });
      if (cancelled) return;
      const res = await pollarFetch(client, address, `/api/events/${id}`);
      if (cancelled) return;
      if (res.status === 404) return setState({ step: "not_found" });
      if (res.status === 403 || res.status === 401) return setState({ step: "forbidden" });
      const event = (await res.json()) as EventDetails;
      setForm({
        name: event.name,
        description: event.description,
        place: event.place,
        datetimeLocal: utcIsoToLaPazLocal(event.datetimeUtc),
        organizerName: event.organizerName,
        organizerContact: event.organizerContact,
      });
      setState({ step: "loaded", event });
    })();
    return () => {
      cancelled = true;
    };
  }, [address, id]);

  if (authLoading) return null;

  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <AppHeader title="Panel del evento" back={{ href: "/", label: "Inicio" }} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PollarLogo size={64} />
          <p className="max-w-sm text-muted">Ingresa con la cuenta que creó este evento para ver su panel.</p>
          <LoginButton />
        </div>
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
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          place: form.place,
          organizerName: form.organizerName,
          organizerContact: form.organizerContact,
          datetimeUtc: form.datetimeLocal ? laPazLocalToUtcIso(form.datetimeLocal) : undefined,
        }),
      });
      const data = (await res.json()) as EventDetails & { error?: string };
      if (!res.ok) {
        setSaveError(data.error ?? "No se pudo guardar");
        return;
      }
      setState({ step: "loaded", event: data });
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Algo salió mal");
    } finally {
      setSaving(false);
    }
  }

  const event = state.step === "loaded" ? state.event : null;
  const inProgress = event ? Math.max(0, event.reserved - event.paid) : 0;
  const closed = event ? salesClosed(event.datetimeUtc) : false;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title="Panel del evento" back={{ href: "/mis-eventos", label: "Mis eventos" }} />

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
        <Card className="flex flex-col gap-2 text-center">
          <p className="font-semibold text-error">Este evento no es tuyo</p>
          <p className="text-sm text-muted">
            Solo la cuenta que creó el evento puede ver su panel. Revisa con qué correo ingresaste.
          </p>
        </Card>
      )}

      {event && (
        <>
          {justCreated && (
            <div className="flex items-start gap-3 rounded-2xl border border-success-border bg-success-light p-4 text-sm leading-6">
              <Icon name="check" size={20} className="mt-0.5 text-success" />
              <p>
                <span className="font-semibold text-success">¡Tu evento está publicado!</span>{" "}
                Comparte el link de abajo para empezar a vender entradas.
              </p>
            </div>
          )}

          <Card className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-xl font-extrabold leading-tight tracking-tight">{event.name}</h2>
                <p className="mt-1 text-sm text-muted first-letter:uppercase">
                  {formatEventDateTime(event.datetimeUtc)} · {event.place}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  closed ? "bg-surface text-muted" : "bg-success-light text-success"
                }`}
              >
                {closed ? "Finalizado" : "En venta"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Vendidas" value={`${event.paid} / ${event.capacity}`} />
              <Stat
                label="Recaudado"
                value={formatAmount(
                  stroopsToDecimal(decimalToStroops(event.priceDecimal) * BigInt(event.paid))
                )}
                hint="USDC"
              />
              <Stat label="Ingresaron" value={String(event.checkedIn)} hint="validadas en la puerta" />
              <Stat
                label="Pagos en curso"
                value={String(inProgress)}
                hint="cupos reservados (15 min)"
              />
            </div>
            <Link href={`/e/${event.id}`} className="flex items-center gap-1.5 text-sm font-semibold text-primary">
              <Icon name="external" size={15} />
              Ver la página pública (como la ve un comprador)
            </Link>
          </Card>

          {!closed && (
            <ShareEventCard eventId={event.id} eventName={event.name} datetimeUtc={event.datetimeUtc} />
          )}

          <ActionLink
            href={`/organizador/eventos/${event.id}/puerta`}
            icon="scan"
            title="Modo puerta"
            description="Escanea las entradas el día del evento"
          />
          {!closed && (
            <DoorStaffCard
              eventId={event.id}
              eventName={event.name}
              initialToken={event.doorToken}
            />
          )}
          <ActionLink
            href={`/organizador/eventos/${event.id}/ventas`}
            icon="chart"
            title="Ventas"
            description="Cada pago, su comprobante y quién ingresó"
          />

          <Card className="flex flex-col gap-4">
            <button
              onClick={() => setEditing((v) => !v)}
              className="flex items-center justify-between gap-3 text-left"
              aria-expanded={editing}
            >
              <span className="flex items-center gap-2 font-semibold">
                <Icon name="pencil" size={17} className="text-primary" />
                Editar datos del evento
              </span>
              <Icon
                name="chevron"
                size={18}
                className={`text-muted transition-transform ${editing ? "rotate-90" : ""}`}
              />
            </button>
            {editing && (
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
                <Input
                  label="Organiza (nombre visible)"
                  value={form.organizerName}
                  onChange={(e) => setForm((f) => ({ ...f, organizerName: e.target.value }))}
                />
                <Input
                  label="Contacto para consultas"
                  placeholder="WhatsApp (70012345) o @instagram"
                  value={form.organizerContact}
                  onChange={(e) => setForm((f) => ({ ...f, organizerContact: e.target.value }))}
                />
                <Input
                  label="Fecha y hora (hora de Bolivia)"
                  type="datetime-local"
                  value={form.datetimeLocal}
                  onChange={(e) => setForm((f) => ({ ...f, datetimeLocal: e.target.value }))}
                />
                <p className="text-xs leading-5 text-muted">
                  Precio ({formatAmount(event.priceDecimal)} USDC) y cupo ({event.capacity}) son fijos:
                  ya hay compradores que confían en ellos.
                </p>
                {saveError && (
                  <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
                    {saveError}
                  </p>
                )}
                <Button type="submit" loading={saving}>
                  Guardar cambios
                </Button>
              </form>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
