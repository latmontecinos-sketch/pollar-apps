"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";

/** Local datetime-local input value -> UTC ISO string. */
function localToUtcIso(local: string): string {
  return new Date(local).toISOString();
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
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-12 text-center">
        <PollarLogo size={72} />
        <p className="max-w-sm text-muted">
          Iniciá sesión para crear un evento. Vas a ser el organizador — dueño
          del panel de ventas y de la puerta.
        </p>
        <LoginButton />
      </main>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await pollarFetch(getClient(), user!.address, "/api/events", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          place,
          datetimeUtc: localToUtcIso(datetimeLocal),
          priceDecimal: price,
          capacity: Number(capacity),
        }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setError(data.error ?? "No se pudo crear el evento");
        return;
      }
      router.push(`/organizador/eventos/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo salió mal");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <header className="flex items-center gap-2.5 py-2">
        <Link href="/" aria-label="Ir al inicio">
          <PollarLogo size={28} />
        </Link>
        <h1 className="text-xl font-bold tracking-tight">Crear evento</h1>
      </header>

      <Card>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input
            label="Nombre del evento"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Input
            label="Descripción (opcional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Input
            label="Lugar"
            value={place}
            onChange={(e) => setPlace(e.target.value)}
            required
          />
          <Input
            label="Fecha y hora (America/La_Paz)"
            type="datetime-local"
            value={datetimeLocal}
            onChange={(e) => setDatetimeLocal(e.target.value)}
            required
          />
          <Input
            label="Precio por entrada (USDC)"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="10.00"
            required
          />
          <Input
            label="Cupo total"
            type="number"
            min={1}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            required
          />

          {error && (
            <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}

          <Button type="submit" loading={submitting}>
            Crear evento
          </Button>
        </form>
      </Card>
    </main>
  );
}
