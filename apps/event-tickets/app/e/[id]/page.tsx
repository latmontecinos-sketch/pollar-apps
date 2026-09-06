import { notFound } from "next/navigation";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { formatEventDateTime } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { BuyButton } from "@/components/BuyButton";

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

async function loadPublicEvent(id: string): Promise<EventRow | null> {
  await dbReady();
  const result = await db.execute({
    sql: "SELECT id, name, description, datetime_utc, place, price_stroops, capacity, reserved FROM events WHERE id = ?",
    args: [id],
  });
  return result.rows.length > 0 ? (result.rows[0] as unknown as EventRow) : null;
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

  const remaining = event.capacity - event.reserved;
  const soldOut = remaining <= 0;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <header className="flex items-center gap-2.5 py-2">
        <PollarLogo size={28} />
        <span className="text-sm font-semibold text-muted">Pollar Pass</span>
      </header>

      <Card className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{event.name}</h1>
          {event.description && (
            <p className="mt-1 text-sm leading-6 text-muted">{event.description}</p>
          )}
        </div>

        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Cuándo</dt>
            <dd className="font-medium">{formatEventDateTime(event.datetime_utc)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Dónde</dt>
            <dd className="font-medium">{event.place}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Precio</dt>
            <dd className="font-mono font-semibold">
              {stroopsToDecimal(BigInt(event.price_stroops))} USDC
            </dd>
          </div>
        </dl>

        <div
          className={`rounded-xl px-4 py-3 text-center text-sm font-semibold ${
            soldOut
              ? "bg-error-light text-error"
              : "bg-primary-light text-primary"
          }`}
        >
          {soldOut ? "Agotado" : `${remaining} de ${event.capacity} cupos disponibles`}
        </div>

        {!soldOut && <BuyButton eventId={event.id} />}
      </Card>
    </main>
  );
}
