import type { Dict } from "./es.ts";

/** The shape every API error response carries: a stable `code` for the UI, plus the server's own (Spanish) `error` text for logs and non-UI clients. */
export type ApiError = { code?: string; error?: string };

/**
 * What the user actually reads for a failed request. Never the server's raw
 * `error` first — that's Spanish regardless of the reader's language — only
 * as a fallback for a `code` the client doesn't recognize yet, and finally a
 * generic message local to the caller.
 */
export function apiErrorMessage(t: Dict, data: ApiError, fallback: string): string {
  const code = data.code;
  if (code && Object.prototype.hasOwnProperty.call(t.apiErrors, code)) {
    return t.apiErrors[code as keyof Dict["apiErrors"]];
  }
  return data.error ?? fallback;
}
