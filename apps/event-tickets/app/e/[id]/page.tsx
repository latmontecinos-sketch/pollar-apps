import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { formatAmount, formatEventDateTime, salesClosed } from "@/lib/format";
import { sweepExpiredSales } from "@/lib/sales";
import { AppHeader } from "@/components/AppHeader";
import { BuyButton } from "@/components/BuyButton";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";

type EventRow = {
  id: string;
  name: string;
  description: string;
  datetime_utc: string;
  place: string;
  price_stroops: string;
  capacity: number;
  reserved: number;
};

/** Shared by generateMetadata and the page (one DB read per request). */
const loadPublicEvent = cache(async (id: string): Promise<EventRow | null> => {
  await dbReady();
  // Release seats held by abandoned checkouts, so "cupos disponibles" is honest.
  await sweepExpiredSales({ eventId: id });
  const result = await db.execute({
    sql: "SELECT id, name, description, datetime_utc, place, price_stroops, capacity, reserved FROM events WHERE id = ?",
    args: [id],
  });
  return result.rows.length > 0 ? (result.rows[0] as unknown as EventRow) : null;
});

/** What WhatsApp/Telegram/etc. show when the organizer shares the link. */
export async function generateMetadata({ params }: PageProps<"/e/[id]">): Promise<Metadata> {
  const { id } = await params;
  const event = await loadPublicEvent(id);
  if (!event) return { title: "Evento no encontrado" };
  const price = formatAmount(stroopsToDecimal(BigInt(event.price_stroops)));
  const description = `${formatEventDateTime(event.datetime_utc)} · ${event.place} · ${price} USDC. Compra tu entrada con Pollar Pass.`;
  return {
    title: event.name,
    description,
    openGraph: { title: event.name, description },
  };
}

/**
 * Public event page: no login, link-only. Anyone with the URL sees name,
 * date, place, price and remaining seats — never the organizer's identity
 * beyond what's already public on-chain.
 */
export default async function PublicEventPage({ params }: PageProps<"/e/[id]">) {
  const { id } = await params;
  const event = await loadPublicEvent(id);
  if (!event) notFound();

  const remaining = Math.max(0, event.capacity - event.reserved);
  const soldOut = remaining <= 0;
  const closed = salesClosed(event.datetime_utc);
  const priceDecimal = stroopsToDecimal(BigInt(event.price_stroops));
  const takenPct = Math.min(100, Math.round((event.reserved / event.capacity) * 100));

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader />

      <Card className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="w-fit rounded-full bg-primary-light px-3 py-1 text-xs font-semibold text-primary">
            Entrada · {formatAmount(priceDecimal)} USDC
          </span>
          <h1 className="text-2xl font-extrabold leading-tight tracking-tight">{event.name}</h1>
          {event.description && (
            <p className="text-sm leading-6 text-muted">{event.description}</p>
          )}
        </div>

        <ul className="flex flex-col gap-3 text-sm">
          <li className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface text-primary">
              <Icon name="calendar" size={18} />
            </span>
            <span className="font-medium first-letter:uppercase">
              {formatEventDateTime(event.datetime_utc)}
            </span>
          </li>
          <li className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface text-primary">
              <Icon name="pin" size={18} />
            </span>
            <span className="font-medium">{event.place}</span>
          </li>
        </ul>

        {closed ? (
          <div className="rounded-xl bg-surface px-4 py-3 text-center text-sm font-semibold text-muted">
            Este evento ya pasó: la venta de entradas está cerrada.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted">
                <Icon name="users" size={16} /> Cupos
              </span>
              <span className={`font-semibold ${soldOut ? "text-error" : "text-foreground"}`}>
                {soldOut ? "Agotado" : `Quedan ${remaining} de ${event.capacity}`}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
              <div
                className={`h-full rounded-full ${soldOut ? "bg-error" : "bg-primary"}`}
                style={{ width: `${takenPct}%` }}
              />
            </div>
          </div>
        )}

        {!soldOut && !closed && (
          <BuyButton eventId={event.id} eventName={event.name} priceDecimal={priceDecimal} />
        )}
      </Card>

      {!soldOut && !closed && (
        <Card className="flex flex-col gap-3 p-5">
          <h2 className="text-sm font-bold">¿Primera vez comprando con Pollar Pass?</h2>
          <ol className="flex flex-col gap-2 text-sm text-muted">
            <li className="flex gap-2">
              <span className="font-bold text-primary">1.</span> Ingresa con tu correo (se crea tu cuenta sola).
            </li>
            <li className="flex gap-2">
              <span className="font-bold text-primary">2.</span> Ten saldo en USDC y toca “Comprar entrada”.
            </li>
            <li className="flex gap-2">
              <span className="font-bold text-primary">3.</span> Recibes un QR: muéstralo en la puerta.
            </li>
          </ol>
          <Link href="/como-funciona" className="text-sm font-semibold text-primary underline">
            Ver la guía completa →
          </Link>
        </Card>
      )}
    </main>
  );
}
