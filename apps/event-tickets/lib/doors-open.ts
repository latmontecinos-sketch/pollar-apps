/**
 * When the doors open, if the organizer says so: an optional instant before
 * (or at) the start, never more than a day before it. Pure.
 */

export const MAX_DOORS_LEAD_MS = 24 * 60 * 60 * 1000;

export type DoorsOpenCheck =
  | { ok: true; value: string | null }
  | { ok: false; code: "doors_invalid" | "doors_after_start" | "doors_too_early" };

/** Spanish `error` for the logs; the UI shows `code`, translated (lib/i18n/errors.ts). */
export const DOORS_ERRORS = {
  doors_invalid: "La hora de apertura de puertas no es válida",
  doors_after_start: "Las puertas no pueden abrir después del inicio",
  doors_too_early: "Las puertas no pueden abrir más de 24 horas antes",
} as const;

/**
 * `raw` is what the request carried: nothing/empty means "no doors time"
 * (also how an edit clears it). The result is the ISO string to store.
 */
export function checkDoorsOpen(raw: unknown, startIsoUtc: string): DoorsOpenCheck {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, code: "doors_invalid" };
  const doors = new Date(raw).getTime();
  const start = new Date(startIsoUtc).getTime();
  if (Number.isNaN(doors) || Number.isNaN(start)) return { ok: false, code: "doors_invalid" };
  if (doors > start) return { ok: false, code: "doors_after_start" };
  if (start - doors > MAX_DOORS_LEAD_MS) return { ok: false, code: "doors_too_early" };
  return { ok: true, value: new Date(doors).toISOString() };
}
