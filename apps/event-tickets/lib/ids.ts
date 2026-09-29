import { randomUUID } from "node:crypto";

/** Primary key for events / sales / tickets rows. */
export function newId(): string {
  return randomUUID();
}
