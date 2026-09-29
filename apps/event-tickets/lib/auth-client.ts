"use client";

import type { PollarClient } from "@pollar/core";
import { authMessage, normalizeRoute, POLLAR_PROOF_HEADER } from "./auth-message.ts";

type CachedProof = { address: string; exp: number; signature: string };

/**
 * One cached signature per (account, endpoint). The signature is bound to
 * the endpoint, so a proof for `GET /api/sales/:id` genuinely can't be
 * reused on `POST /api/events/:id/door-link` — and caching per endpoint
 * keeps that from turning into a wallet popup on every tap.
 */
const cache = new Map<string, CachedProof>();

/** Comfortably under the server's 3-minute ceiling, even with clock drift. */
const PROOF_TTL_MS = 2 * 60 * 1000;

async function proofFor(
  client: PollarClient,
  address: string,
  method: string,
  path: string
): Promise<CachedProof> {
  const key = `${address}|${method} ${normalizeRoute(path)}`;
  const hit = cache.get(key);
  if (hit && hit.exp - 30_000 > Date.now()) return hit;

  const exp = Date.now() + PROOF_TTL_MS;
  const signed = await client.stellar.sep53.signMessage(authMessage(address, exp, method, path));
  if (signed.status !== "signed") {
    throw new Error(signed.details ?? "No se pudo firmar la sesión Pollar");
  }

  const proof: CachedProof = { address: signed.signerAddress || address, exp, signature: signed.signature };
  cache.set(key, proof);
  return proof;
}

/** `fetch()` that attaches a SEP-53 proof of the logged-in Pollar address for our own API routes. */
export async function pollarFetch(
  client: PollarClient,
  address: string,
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  // Only the path is signed: a query string is never part of what a route
  // here decides, and including it would defeat the per-endpoint cache.
  const path = new URL(input, window.location.origin).pathname;

  const proof = await proofFor(client, address, method, path);
  const headers = new Headers(init.headers);
  headers.set(POLLAR_PROOF_HEADER, JSON.stringify(proof));
  // JSON unless the caller says otherwise: the event photo goes up as raw JPEG bytes.
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(input, { ...init, headers });
}
