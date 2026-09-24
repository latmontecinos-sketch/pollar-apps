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
import { useLocale, useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";
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
  ticketTypes: TicketTypeView[];
};

type TicketTypeView = {
  id: string;
  name: string;
  priceDecimal: string;
  capacity: number;
  reserved: number;
  paid: number;
  checkedIn: number;
  capacityIncreasesLeft: number;
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
  const t = useT();
  const locale = useLocale();
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
  /** Keyed by tier id: each tier extends its own capacity. */
  const [newCapacity, setNewCapacity] = useState<Record<string, string>>({});
  const [capacityBusy, setCapacityBusy] = useState(false);
  const [capacityError, setCapacityError] = useState<string | null>(null);

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
        <AppHeader title={t.panel.title} back={{ href: "/app", label: t.common.home }} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PollarLogo size={64} />
          <p className="max-w-sm text-muted">{t.panel.loginNote}</p>
          <LoginButton />
        </div>
      </main>
    );
  }

  async function patch(body: Record<string, unknown>) {
    return pollarFetch(pollar.getClient(), user!.address, `/api/events/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      const res = await patch({
        name: form.name,
        description: form.description,
        place: form.place,
        organizerName: form.organizerName,
        organizerContact: form.organizerContact,
        datetimeUtc: form.datetimeLocal ? laPazLocalToUtcIso(form.datetimeLocal) : undefined,
      });
      const data = (await res.json()) as EventDetails & { error?: string; code?: string };
      if (!res.ok) {
        setSaveError(apiErrorMessage(t, data, t.panel.saveError));
        return;
      }
      setState({ step: "loaded", event: data });
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t.panel.saveError);
    } finally {
      setSaving(false);
    }
  }

  async function extendCapacity(type: TicketTypeView) {
    setCapacityError(null);
    const wanted = Number(newCapacity[type.id] ?? "");
    if (!Number.isInteger(wanted) || wanted <= type.capacity) {
      setCapacityError(t.capacity.errorLower);
      return;
    }
    setCapacityBusy(true);
    try {
      const res = await patch({ ticketTypeId: type.id, capacity: wanted });
      const data = (await res.json()) as EventDetails & { error?: string; code?: string };
      if (!res.ok) {
        setCapacityError(
          data.code === "capacity_limit" ? t.capacity.errorLimit : apiErrorMessage(t, data, t.panel.saveError)
        );
        return;
      }
      setState({ step: "loaded", event: data });
      setNewCapacity((current) => ({ ...current, [type.id]: "" }));
    } catch (err) {
      setCapacityError(err instanceof Error ? err.message : t.panel.saveError);
    } finally {
      setCapacityBusy(false);
    }
  }

  const event = state.step === "loaded" ? state.event : null;
  const inProgress = event ? Math.max(0, event.reserved - event.paid) : 0;
  const closed = event ? salesClosed(event.datetimeUtc) : false;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title={t.panel.title} back={{ href: "/mis-eventos", label: t.myEvents.title }} />

      {state.step === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {state.step === "not_found" && (
        <Card>
          <p className="text-center text-sm text-muted">{t.panel.notFound}</p>
        </Card>
      )}

      {state.step === "forbidden" && (
        <Card className="flex flex-col gap-2 text-center">
          <p className="font-semibold text-error">{t.panel.forbiddenTitle}</p>
          <p className="text-sm text-muted">{t.panel.forbiddenBody}</p>
        </Card>
      )}

      {event && (
        <>
          {justCreated && (
            <div className="pollar-rise flex items-start gap-3 rounded-2xl border border-success-border bg-success-light p-4 text-sm leading-6">
              <Icon name="check" size={20} className="mt-0.5 text-success" />
              <p>
                <span className="font-semibold text-success">{t.panel.createdStrong}</span>{" "}
                {t.panel.createdBody}
              </p>
            </div>
          )}

          <Card className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-xl font-extrabold leading-tight tracking-tight">{event.name}</h2>
                <p className="mt-1 text-sm text-muted first-letter:uppercase">
                  {formatEventDateTime(event.datetimeUtc, locale)} · {event.place}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  closed ? "bg-surface text-muted" : "bg-success-light text-success"
                }`}
              >
                {closed ? t.panel.finished : t.panel.onSale}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label={t.panel.statSold} value={`${event.paid} / ${event.capacity}`} />
              <Stat
                label={t.panel.statRevenue}
                value={formatAmount(
                  stroopsToDecimal(decimalToStroops(event.priceDecimal) * BigInt(event.paid)),
                  locale
                )}
                hint="USDC"
              />
              <Stat
                label={t.panel.statCheckedIn}
                value={String(event.checkedIn)}
                hint={t.panel.statCheckedInHint}
              />
              <Stat
                label={t.panel.statInProgress}
                value={String(inProgress)}
                hint={t.panel.statInProgressHint}
              />
            </div>
            <Link href={`/e/${event.id}`} className="flex items-center gap-1.5 text-sm font-semibold text-primary">
              <Icon name="external" size={15} />
              {t.panel.publicLink}
            </Link>
          </Card>

          {!closed && (
            <ShareEventCard eventId={event.id} eventName={event.name} datetimeUtc={event.datetimeUtc} />
          )}

          <ActionLink
            href={`/organizador/eventos/${event.id}/puerta`}
            icon="scan"
            title={t.panel.doorTile}
            description={t.panel.doorTileBody}
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
            title={t.panel.salesTile}
            description={t.panel.salesTileBody}
          />

          <Card className="flex flex-col gap-4">
            <h2 className="flex items-center gap-2 font-bold">
              <Icon name="ticket" size={18} className="text-primary" />
              {t.tiers.sectionTitle}
            </h2>
            {event.ticketTypes.map((type) => (
              <div key={type.id} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{type.name}</p>
                    <p className="text-xs text-muted">
                      {t.myEvents.sold(type.paid, type.capacity)} · {t.panel.statCheckedIn}:{" "}
                      {type.checkedIn}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono font-semibold">
                    {formatAmount(type.priceDecimal, locale)}
                    <span className="ml-1 text-xs font-normal text-muted">USDC</span>
                  </span>
                </div>
                {!closed &&
                  (type.capacityIncreasesLeft > 0 ? (
                    <>
                      <p className="text-xs leading-5 text-muted">
                        {t.capacity.body(type.capacityIncreasesLeft)}
                      </p>
                      <div className="flex items-end gap-2">
                        <Input
                          label={t.capacity.field}
                          type="number"
                          inputMode="numeric"
                          min={type.capacity + 1}
                          placeholder={String(type.capacity + 10)}
                          value={newCapacity[type.id] ?? ""}
                          onChange={(e) =>
                            setNewCapacity((current) => ({ ...current, [type.id]: e.target.value }))
                          }
                          className="flex-1"
                        />
                        <Button
                          loading={capacityBusy}
                          disabled={!(newCapacity[type.id] ?? "").trim()}
                          onClick={() => void extendCapacity(type)}
                        >
                          {t.capacity.submit}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs leading-5 text-muted">{t.capacity.exhausted}</p>
                  ))}
              </div>
            ))}
            {capacityError && (
              <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
                {capacityError}
              </p>
            )}
          </Card>

          <Card className="flex flex-col gap-4">
            <button
              onClick={() => setEditing((v) => !v)}
              className="flex items-center justify-between gap-3 text-left"
              aria-expanded={editing}
            >
              <span className="flex items-center gap-2 font-semibold">
                <Icon name="pencil" size={17} className="text-primary" />
                {t.panel.editToggle}
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
                  label={t.panel.editName}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
                <Input
                  label={t.panel.editDescription}
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
                <Input
                  label={t.panel.editPlace}
                  value={form.place}
                  onChange={(e) => setForm((f) => ({ ...f, place: e.target.value }))}
                />
                <Input
                  label={t.panel.editOrganizerName}
                  value={form.organizerName}
                  onChange={(e) => setForm((f) => ({ ...f, organizerName: e.target.value }))}
                />
                <Input
                  label={t.panel.editOrganizerContact}
                  placeholder={t.create.organizerContactPlaceholder}
                  value={form.organizerContact}
                  onChange={(e) => setForm((f) => ({ ...f, organizerContact: e.target.value }))}
                />
                <Input
                  label={t.panel.editDatetime}
                  type="datetime-local"
                  value={form.datetimeLocal}
                  onChange={(e) => setForm((f) => ({ ...f, datetimeLocal: e.target.value }))}
                />
                <p className="text-xs leading-5 text-muted">
                  {t.panel.immutable(formatAmount(event.priceDecimal, locale), event.capacity)}
                </p>
                {saveError && (
                  <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
                    {saveError}
                  </p>
                )}
                <Button type="submit" loading={saving}>
                  {t.panel.save}
                </Button>
              </form>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
