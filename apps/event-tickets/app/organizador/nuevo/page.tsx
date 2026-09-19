"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import {
  formatAmount,
  laPazLocalToUtcIso,
  normalizeDecimalInput,
  utcIsoToLaPazLocal,
} from "@/lib/format";
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
  const router = useRouter();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [place, setPlace] = useState("");
  const [datetimeLocal, setDatetimeLocal] = useState("");
  const [price, setPrice] = useState("");
  const [capacity, setCapacity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (authLoading) return null;

  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <AppHeader title="Crear evento" back={{ href: "/", label: "Inicio" }} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PollarLogo size={64} />
          <p className="max-w-sm text-muted">
            Ingresa para crear tu evento. Serás el organizador: los pagos llegan a tu cuenta y
            solo tú ves las ventas y el modo puerta.
          </p>
          <LoginButton />
        </div>
      </main>
    );
  }

  const normalizedPrice = normalizeDecimalInput(price);
  const priceValid = /^\d+(\.\d{1,7})?$/.test(normalizedPrice) && Number(normalizedPrice) > 0;
  const capacityNumber = Number(capacity);
  const maxRevenue =
    priceValid && Number.isInteger(capacityNumber) && capacityNumber > 0
      ? formatAmount(stroopsToDecimal(decimalToStroops(normalizedPrice) * BigInt(capacityNumber)))
      : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!priceValid) {
      setError("Escribe el precio como número, por ejemplo 2,50");
      return;
    }
    const datetimeUtc = laPazLocalToUtcIso(datetimeLocal);
    if (new Date(datetimeUtc).getTime() < Date.now()) {
      setError("La fecha del evento ya pasó — elige una fecha futura");
      return;
    }
    setSubmitting(true);
    try {
      const res = await pollarFetch(getClient(), user!.address, "/api/events", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          place,
          datetimeUtc,
          priceDecimal: normalizedPrice,
          capacity: capacityNumber,
        }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setError(data.error ?? "No se pudo crear el evento");
        return;
      }
      router.push(`/organizador/eventos/${data.id}?nuevo=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo salió mal");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title="Crear evento" back={{ href: "/mis-eventos", label: "Mis eventos" }} />

      <p className="px-1 text-sm leading-6 text-muted">
        Completa los datos y publica. Al terminar te damos el link para compartir por WhatsApp.
      </p>

      <Card>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">
              El evento
            </legend>
            <Input
              label="Nombre del evento"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: Noche de jazz en Sopocachi"
              maxLength={80}
              required
            />
            <Input
              label="Descripción (opcional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Qué incluye, quién toca, qué llevar…"
              maxLength={280}
            />
            <Input
              label="Lugar"
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              placeholder="Ej: Café Mirador, Av. 20 de Octubre, La Paz"
              required
            />
            <Input
              label="Fecha y hora"
              type="datetime-local"
              value={datetimeLocal}
              min={utcIsoToLaPazLocal(new Date().toISOString())}
              onChange={(e) => setDatetimeLocal(e.target.value)}
              required
            />
            <Hint>Hora de Bolivia, aunque tu celular esté en otra zona horaria.</Hint>
          </fieldset>

          <fieldset className="flex flex-col gap-4 border-t border-border pt-5">
            <legend className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">
              Entradas
            </legend>
            <Input
              label="Precio por entrada (USDC)"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Ej: 2,50"
              required
            />
            <Hint>1 USDC ≈ 1 dólar. Cada pago llega directo a tu cuenta Pollar.</Hint>
            <Input
              label="Cupo total"
              type="number"
              inputMode="numeric"
              min={1}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder="Ej: 50"
              required
            />
            <Hint>Cuántas entradas se pueden vender como máximo.</Hint>
          </fieldset>

          <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3 text-xs leading-5 text-muted">
            <Icon name="alert" size={16} className="mt-0.5 text-warning" />
            <span>
              El <strong className="text-foreground">precio y el cupo no se pueden cambiar</strong>{" "}
              después de publicar (protege a quien ya compró). Nombre, descripción, lugar y fecha sí.
              {maxRevenue && (
                <>
                  {" "}Si vendes todo, recaudas{" "}
                  <strong className="font-mono text-foreground">{maxRevenue} USDC</strong>.
                </>
              )}
            </span>
          </div>

          {error && (
            <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}

          <Button type="submit" loading={submitting} className="w-full py-3">
            Publicar evento
          </Button>
        </form>
      </Card>
    </main>
  );
}
