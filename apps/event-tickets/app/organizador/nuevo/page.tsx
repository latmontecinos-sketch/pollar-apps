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
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="-mt-2 text-xs leading-5 text-muted">{children}</p>;
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
  const [price, setPrice] = useState("");
  const [capacity, setCapacity] = useState("");
  const [organizerName, setOrganizerName] = useState("");
  const [organizerContact, setOrganizerContact] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Nothing is published until the organizer has seen it as a buyer will. */
  const [preview, setPreview] = useState(false);

  if (authLoading) return null;

  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <AppHeader title={t.create.title} back={{ href: "/", label: t.common.home }} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PollarLogo size={64} />
          <p className="max-w-sm text-muted">{t.create.loginNote}</p>
          <LoginButton />
        </div>
      </main>
    );
  }

  const normalizedPrice = normalizeDecimalInput(price);
  const priceValid = /^\d+(\.\d{1,7})?$/.test(normalizedPrice) && Number(normalizedPrice) > 0;
  const capacityNumber = Number(capacity);
  const capacityValid = Number.isInteger(capacityNumber) && capacityNumber > 0;
  const maxRevenue =
    priceValid && capacityValid
      ? formatAmount(stroopsToDecimal(decimalToStroops(normalizedPrice) * BigInt(capacityNumber)), locale)
      : null;

  function review(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!priceValid) return setError(t.create.errorPrice);
    if (new Date(laPazLocalToUtcIso(datetimeLocal)).getTime() < Date.now()) {
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
          priceDecimal: normalizedPrice,
          capacity: capacityNumber,
          organizerName,
          organizerContact,
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
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
        <AppHeader title={t.preview.title} back={{ href: "/mis-eventos", label: t.myEvents.title }} />
        <p className="px-1 text-sm leading-6 text-muted">{t.preview.body}</p>

        {/* Same shape as the public page, so there are no surprises after publishing. */}
        <Card className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span className="w-fit rounded-full bg-primary-light px-3 py-1 text-xs font-semibold text-primary">
              {t.event.ticketBadge(formatAmount(normalizedPrice, locale))}
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
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted">
              <Icon name="users" size={16} /> {t.event.seats}
            </span>
            <span className="font-semibold">{t.event.remaining(capacityNumber, capacityNumber)}</span>
          </div>
        </Card>

        {maxRevenue && (
          <p className="px-1 text-xs leading-5 text-muted">{t.create.maxRevenue(maxRevenue).trim()}</p>
        )}

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
              {t.create.sectionTickets}
            </legend>
            <Input
              label={t.create.price}
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={t.create.pricePlaceholder}
              required
            />
            <Hint>{t.create.priceHint}</Hint>
            <Input
              label={t.create.capacity}
              type="number"
              inputMode="numeric"
              min={1}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder={t.create.capacityPlaceholder}
              required
            />
            <Hint>{t.create.capacityHint}</Hint>
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
