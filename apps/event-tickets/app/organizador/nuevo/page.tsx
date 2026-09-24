"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import {
  contactHref,
  formatAmount,
  formatEventDateTime,
  laPazLocalToUtcIso,
  normalizeDecimalInput,
  utcIsoToLaPazLocal,
} from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { decimalToStroops, stroopsToDecimal } from "@/lib/money";
import { MAX_TICKET_TYPES } from "@/lib/ticket-limits";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";

/** One row of the tier editor, as typed (prices stay strings until validated). */
type TierDraft = { name: string; price: string; capacity: string };

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="-mt-2 text-xs leading-5 text-muted">{children}</p>;
}

/** Module scope on purpose: reading the clock isn't something a render may do. */
function isInThePast(isoUtc: string): boolean {
  return new Date(isoUtc).getTime() < Date.now();
}

export default function CreateEventPage() {
  const { user, isLoading: authLoading } = usePollarAuth();
  const { getClient } = usePollar();
  const t = useT();
  const locale = useLocale();
  const router = useRouter();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [place, setPlace] = useState("");
  const [datetimeLocal, setDatetimeLocal] = useState("");
  const [organizerName, setOrganizerName] = useState("");
  const [organizerContact, setOrganizerContact] = useState("");
  const [tiers, setTiers] = useState<TierDraft[]>([
    { name: t.tiers.defaultName, price: "", capacity: "" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Nothing is published until the organizer has seen it as a buyer will. */
  const [preview, setPreview] = useState(false);

  if (authLoading) return null;

  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <AppHeader title={t.create.title} back={{ href: "/app", label: t.common.home }} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PollarLogo size={64} />
          <p className="max-w-sm text-muted">{t.create.loginNote}</p>
          <LoginButton />
        </div>
      </main>
    );
  }

  function updateTier(index: number, patch: Partial<TierDraft>) {
    setTiers((current) => current.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
  }

  const parsedTiers = tiers.map((tier) => {
    const price = normalizeDecimalInput(tier.price);
    const capacity = Number(tier.capacity);
    return {
      name: tier.name.trim(),
      priceDecimal: price,
      capacity,
      priceValid: (() => {
        try {
          return decimalToStroops(price) > 0n;
        } catch {
          return false;
        }
      })(),
      capacityValid: Number.isInteger(capacity) && capacity > 0,
    };
  });
  const totalCapacity = parsedTiers.reduce(
    (sum, tier) => sum + (tier.capacityValid ? tier.capacity : 0),
    0
  );
  const maxRevenue = parsedTiers.every((tier) => tier.priceValid && tier.capacityValid)
    ? formatAmount(
        stroopsToDecimal(
          parsedTiers.reduce(
            (sum, tier) => sum + decimalToStroops(tier.priceDecimal) * BigInt(tier.capacity),
            0n
          )
        ),
        locale
      )
    : null;

  function review(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    for (const tier of parsedTiers) {
      if (!tier.name) return setError(t.tiers.errorName);
      if (!tier.priceValid) return setError(t.tiers.errorPrice);
      if (!tier.capacityValid) return setError(t.tiers.errorCapacity);
    }
    const names = parsedTiers.map((tier) => tier.name.toLocaleLowerCase());
    if (new Set(names).size !== names.length) return setError(t.tiers.errorDuplicate);
    if (isInThePast(laPazLocalToUtcIso(datetimeLocal))) {
      return setError(t.create.errorPastDate);
    }
    setPreview(true);
  }

  async function publish() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await pollarFetch(getClient(), user!.address, "/api/events", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          place,
          datetimeUtc: laPazLocalToUtcIso(datetimeLocal),
          organizerName,
          organizerContact,
          ticketTypes: parsedTiers.map((tier) => ({
            name: tier.name,
            priceDecimal: tier.priceDecimal,
            capacity: tier.capacity,
          })),
        }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setPreview(false);
        setError(data.error ?? t.create.errorGeneric);
        return;
      }
      router.push(`/organizador/eventos/${data.id}?nuevo=1`);
    } catch (err) {
      setPreview(false);
      setError(err instanceof Error ? err.message : t.create.errorGeneric);
    } finally {
      setSubmitting(false);
    }
  }

  if (preview) {
    const contact = contactHref(organizerContact);
    const cheapest = parsedTiers.reduce(
      (min, tier) => (decimalToStroops(tier.priceDecimal) < min ? decimalToStroops(tier.priceDecimal) : min),
      decimalToStroops(parsedTiers[0].priceDecimal)
    );
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
        <AppHeader title={t.preview.title} back={{ href: "/mis-eventos", label: t.myEvents.title }} />
        <p className="px-1 text-sm leading-6 text-muted">{t.preview.body}</p>

        {/* Same shape as the public page, so there are no surprises after publishing. */}
        <Card className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span className="w-fit rounded-full bg-primary-light px-3 py-1 text-xs font-semibold text-primary">
              {t.tiers.from(formatAmount(stroopsToDecimal(cheapest), locale))}
            </span>
            <h2 className="text-2xl font-extrabold leading-tight tracking-tight">{name}</h2>
            {description && <p className="text-sm leading-6 text-muted">{description}</p>}
          </div>
          <ul className="flex flex-col gap-3 text-sm">
            <li className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface text-primary">
                <Icon name="calendar" size={18} />
              </span>
              <span className="font-medium first-letter:uppercase">
                {formatEventDateTime(laPazLocalToUtcIso(datetimeLocal), locale)}
              </span>
            </li>
            <li className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface text-primary">
                <Icon name="pin" size={18} />
              </span>
              <span className="font-medium">{place}</span>
            </li>
            {(organizerName || organizerContact) && (
              <li className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface text-primary">
                  <Icon name="users" size={18} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {t.event.organizedBy(organizerName || t.event.organizerFallback)}
                  </span>
                  {organizerContact && (
                    <span className={`truncate text-xs ${contact ? "text-primary" : "text-muted"}`}>
                      {t.event.contactLink(organizerContact)}
                    </span>
                  )}
                </span>
              </li>
            )}
          </ul>
        </Card>

        <section className="flex flex-col gap-2">
          <h3 className="px-1 text-sm font-bold">{t.tiers.sectionTitle}</h3>
          {parsedTiers.map((tier) => (
            <Card key={tier.name} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-semibold">{tier.name}</p>
                <p className="text-xs text-muted">{t.tiers.remaining(tier.capacity)}</p>
              </div>
              <span className="shrink-0 font-mono text-lg font-bold">
                {formatAmount(tier.priceDecimal, locale)}
                <span className="ml-1 text-xs font-normal text-muted">USDC</span>
              </span>
            </Card>
          ))}
          <p className="px-1 text-xs leading-5 text-muted">
            {t.tiers.totalCapacity(totalCapacity)}
            {maxRevenue && t.create.maxRevenue(maxRevenue)}
          </p>
        </section>

        {error && (
          <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setPreview(false)} disabled={submitting}>
            {t.preview.back}
          </Button>
          <Button loading={submitting} onClick={() => void publish()}>
            {t.preview.confirm}
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title={t.create.title} back={{ href: "/mis-eventos", label: t.myEvents.title }} />

      <p className="px-1 text-sm leading-6 text-muted">{t.create.intro}</p>

      <Card>
        <form onSubmit={review} className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">
              {t.create.sectionEvent}
            </legend>
            <Input
              label={t.create.name}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.create.namePlaceholder}
              maxLength={80}
              required
            />
            <Input
              label={t.create.description}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.create.descriptionPlaceholder}
              maxLength={280}
            />
            <Input
              label={t.create.place}
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              placeholder={t.create.placePlaceholder}
              required
            />
            <Input
              label={t.create.datetime}
              type="datetime-local"
              value={datetimeLocal}
              min={utcIsoToLaPazLocal(new Date().toISOString())}
              onChange={(e) => setDatetimeLocal(e.target.value)}
              required
            />
            <Hint>{t.create.datetimeHint}</Hint>
          </fieldset>

          <fieldset className="flex flex-col gap-4 border-t border-border pt-5">
            <legend className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">
              {t.create.sectionOrganizer}
            </legend>
            <Input
              label={t.create.organizerName}
              value={organizerName}
              onChange={(e) => setOrganizerName(e.target.value)}
              placeholder={t.create.organizerNamePlaceholder}
              maxLength={80}
              required
            />
            <Input
              label={t.create.organizerContact}
              value={organizerContact}
              onChange={(e) => setOrganizerContact(e.target.value)}
              placeholder={t.create.organizerContactPlaceholder}
              maxLength={120}
            />
            <Hint>{t.create.organizerHint}</Hint>
          </fieldset>

          <fieldset className="flex flex-col gap-4 border-t border-border pt-5">
            <legend className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">
              {t.tiers.sectionTitle}
            </legend>
            <Hint>{t.tiers.typeHint}</Hint>

            {tiers.map((tier, index) => (
              <div
                key={index}
                className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3"
              >
                <div className="flex items-end gap-2">
                  <Input
                    label={t.tiers.typeName}
                    value={tier.name}
                    onChange={(e) => updateTier(index, { name: e.target.value })}
                    placeholder={t.tiers.typeNamePlaceholder}
                    maxLength={40}
                    required
                    className="flex-1"
                  />
                  {tiers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setTiers((current) => current.filter((_, i) => i !== index))}
                      aria-label={t.tiers.removeType}
                      className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl border border-border text-muted transition-colors hover:border-error-border hover:text-error"
                    >
                      <Icon name="x" size={16} />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label={t.tiers.typePrice}
                    inputMode="decimal"
                    value={tier.price}
                    onChange={(e) => updateTier(index, { price: e.target.value })}
                    placeholder={t.create.pricePlaceholder}
                    required
                  />
                  <Input
                    label={t.tiers.typeCapacity}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={tier.capacity}
                    onChange={(e) => updateTier(index, { capacity: e.target.value })}
                    placeholder={t.create.capacityPlaceholder}
                    required
                  />
                </div>
              </div>
            ))}

            {tiers.length < MAX_TICKET_TYPES && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setTiers((current) => [...current, { name: "", price: "", capacity: "" }])}
              >
                <Icon name="plus" size={16} />
                {t.tiers.addType}
              </Button>
            )}
            <Hint>{t.create.priceHint}</Hint>
          </fieldset>

          <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3 text-xs leading-5 text-muted">
            <Icon name="alert" size={16} className="mt-0.5 text-warning" />
            <span>
              <strong className="text-foreground">{t.create.immutableStrong}</strong>{" "}
              {t.create.immutableBody}
              {maxRevenue && t.create.maxRevenue(maxRevenue)}
            </span>
          </div>

          {error && (
            <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full py-3">
            {t.preview.title}
          </Button>
        </form>
      </Card>
    </main>
  );
}
