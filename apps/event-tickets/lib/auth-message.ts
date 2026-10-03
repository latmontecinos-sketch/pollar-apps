/** Shared between client (signs) and server (verifies) — no server-only or browser-only imports here. */

import { NETWORK } from "./network.ts";

export const POLLAR_PROOF_HEADER = "x-pollar-proof";

/**
 * Bumped whenever the message shape changes. An old tab's proof then fails
 * verification instead of being interpreted under the new rules — which is
 * the point of signing a version in the first place.
 */
const VERSION = "v3";

/** Collections whose next path segment is an id, not a route. */
const ID_PARENTS = new Set(["events", "sales", "tickets"]);
/** …except these, which are real routes sitting where an id would go. */
const NOT_IDS = new Set(["mine"]);

/**
 * `/api/sales/3f2a…/confirm` -> `/api/sales/:id/confirm`.
 *
 * The signature is bound to the *shape* of the route, not to one concrete
 * id. Binding the exact path would be tighter, but it would also force a
 * fresh signature per sale — and on an external wallet (Freighter, Albedo)
 * every signature is a popup the person has to approve. This keeps one
 * signature per endpoint while still making a proof useless anywhere else:
 * a proof captured from a harmless GET can't be replayed against
 * `POST /api/events/:id/door-link`.
 */
export function normalizeRoute(path: string): string {
  const segments = path.split("/");
  return segments
    .map((segment, index) => {
      const parent = segments[index - 1];
      if (!parent || !ID_PARENTS.has(parent)) return segment;
      if (!segment || NOT_IDS.has(segment)) return segment;
      return ":id";
    })
    .join("/");
}

/**
 * Who a proof is addressed to: the Stellar network and the deployment's host.
 * A proof signed for a staging copy, or for the testnet build, no longer
 * verifies on the production deployment (and vice versa).
 *
 * Honest limit: this stops proofs crossing deployments *by accident*. A
 * hostile page that can ask the wallet to sign anything can write any
 * audience it likes, so it is not a defence against a deliberate phishing
 * clone — nothing a server can add to the message is.
 */
export function authAudience(host: string): string {
  return `${NETWORK}@${host.trim().toLowerCase()}`;
}

/** What actually gets signed: who, for whom, until when, and which endpoint it unlocks. */
export function authMessage(
  address: string,
  exp: number,
  method: string,
  path: string,
  audience: string
): string {
  return `pollarpass-auth:${VERSION}:${audience}:${method.toUpperCase()} ${normalizeRoute(path)}:${address}:${exp}`;
}
