import { db, dbReady } from "./db.ts";
import { newId } from "./ids.ts";
import { decimalToStroops, stroopsToDecimal } from "./money.ts";

import { MAX_CAPACITY_INCREASES, MAX_TICKET_TYPES } from "./ticket-limits.ts";

export { MAX_CAPACITY_INCREASES, MAX_TICKET_TYPES };

export type TicketTypeInput = { name: string; priceDecimal: string; capacity: number };

export type TicketType = {
  id: string;
  name: string;
  priceDecimal: string;
  capacity: number;
  /** Seats not free right now: paid tickets plus live checkouts. */
  reserved: number;
  /** Seats actually sold. */
  paid: number;
  checkedIn: number;
  capacityIncreasesLeft: number;
};

export class TicketTypeError extends Error {
  // Declared, not a constructor parameter property: Node's type stripping
  // (how the spikes and tests run these files) doesn't support those.
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** Validates what the organizer typed, or throws with a code the route maps to a message. */
export function parseTicketTypes(raw: unknown): TicketTypeInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TicketTypeError("Falta al menos un tipo de entrada", "types_required");
  }
  if (raw.length > MAX_TICKET_TYPES) {
    throw new TicketTypeError("Demasiados tipos de entrada", "types_too_many");
  }
  const seen = new Set<string>();
  return raw.map((item) => {
    const candidate = item as Partial<TicketTypeInput>;
    const name = String(candidate.name ?? "").trim().slice(0, 40);
    if (!name) throw new TicketTypeError("Cada tipo de entrada necesita un nombre", "type_name");
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) {
      throw new TicketTypeError("Hay dos tipos de entrada con el mismo nombre", "type_duplicate");
    }
    seen.add(key);

    let priceStroops: bigint;
    try {
      priceStroops = decimalToStroops(String(candidate.priceDecimal ?? ""));
    } catch {
      throw new TicketTypeError("El precio no es válido", "type_price");
    }
    if (priceStroops <= 0n) {
      throw new TicketTypeError("El precio debe ser mayor a 0", "type_price");
    }

    const capacity = Number(candidate.capacity);
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TicketTypeError("El cupo debe ser un entero mayor a 0", "type_capacity");
    }
    return { name, priceDecimal: stroopsToDecimal(priceStroops), capacity };
  });
}

export async function createTicketTypes(
  eventId: string,
  types: TicketTypeInput[]
): Promise<void> {
  await dbReady();
  await db.batch(
    types.map((type, index) => ({
      sql: `INSERT INTO ticket_types (id, event_id, name, price_stroops, capacity, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        newId(),
        eventId,
        type.name,
        decimalToStroops(type.priceDecimal).toString(),
        type.capacity,
        index,
      ],
    })),
    "write"
  );
}

type Row = {
  id: string;
  name: string;
  price_stroops: string;
  capacity: number;
  reserved: number;
  capacity_increases: number;
  paid: number;
  checked_in: number;
};

/** Every tier of an event with its live numbers, in the order the organizer created them. */
export async function listTicketTypes(eventId: string): Promise<TicketType[]> {
  await dbReady();
  const result = await db.execute({
    sql: `SELECT t.id, t.name, t.price_stroops, t.capacity, t.reserved, t.capacity_increases,
                 (SELECT count(*) FROM sales
                  WHERE sales.ticket_type_id = t.id AND sales.status = 'paid') AS paid,
                 (SELECT count(*) FROM tickets
                  JOIN sales ON sales.id = tickets.sale_id
                  WHERE sales.ticket_type_id = t.id AND tickets.used_at IS NOT NULL) AS checked_in
          FROM ticket_types t
          WHERE t.event_id = ?
          ORDER BY t.sort_order, t.created_at`,
    args: [eventId],
  });

  return (result.rows as unknown as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    priceDecimal: stroopsToDecimal(BigInt(row.price_stroops)),
    capacity: Number(row.capacity),
    reserved: Number(row.reserved),
    paid: Number(row.paid),
    checkedIn: Number(row.checked_in),
    capacityIncreasesLeft: Math.max(0, MAX_CAPACITY_INCREASES - Number(row.capacity_increases ?? 0)),
  }));
}

/**
 * Adds seats to one tier. Never removes them (someone already holds those)
 * and never more than twice per tier — an event that keeps "adding tickets"
 * isn't selling a capacity any more.
 */
export async function extendCapacity(
  eventId: string,
  ticketTypeId: string,
  capacity: number
): Promise<{ ok: true } | { ok: false; code: "capacity_lower" | "capacity_limit" | "not_found" }> {
  await dbReady();
  const current = await db.execute({
    sql: "SELECT capacity, capacity_increases FROM ticket_types WHERE id = ? AND event_id = ?",
    args: [ticketTypeId, eventId],
  });
  if (current.rows.length === 0) return { ok: false, code: "not_found" };
  if (!Number.isInteger(capacity) || capacity <= Number(current.rows[0].capacity)) {
    return { ok: false, code: "capacity_lower" };
  }
  if (Number(current.rows[0].capacity_increases ?? 0) >= MAX_CAPACITY_INCREASES) {
    return { ok: false, code: "capacity_limit" };
  }
  await db.execute({
    sql: "UPDATE ticket_types SET capacity = ?, capacity_increases = capacity_increases + 1 WHERE id = ?",
    args: [capacity, ticketTypeId],
  });
  return { ok: true };
}

/** What the event row shows as a summary: cheapest price and the seats across every tier. */
export function summarize(types: TicketType[]): {
  priceStroops: bigint;
  capacity: number;
  reserved: number;
  paid: number;
} {
  const prices = types.map((type) => decimalToStroops(type.priceDecimal));
  return {
    priceStroops: prices.length > 0 ? prices.reduce((a, b) => (a < b ? a : b)) : 0n,
    capacity: types.reduce((sum, type) => sum + type.capacity, 0),
    reserved: types.reduce((sum, type) => sum + type.reserved, 0),
    paid: types.reduce((sum, type) => sum + type.paid, 0),
  };
}
