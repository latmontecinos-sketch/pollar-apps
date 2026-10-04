/**
 * Where this deployment says it lives, and where a request says it arrived.
 * Two things were tangled together before: the hosts a sign-in proof may be
 * addressed to (lib/auth.ts) and the public URL put inside an email
 * (lib/mail.ts). Both read `APP_ORIGIN`, and they need different answers
 * from it, so the parsing lives here once.
 *
 * `APP_ORIGIN` is a list: one origin, or several separated by commas
 * (`https://pollarpass.vercel.app, https://pass.example`). The FIRST is the
 * public one, the one an email links to; every entry is a host a proof may
 * be signed for. An entry without a scheme is read as https.
 *
 * - Defined: only those hosts count. The request's own host is NOT added,
 *   because that is the point of configuring it.
 * - Not defined (dev, or a deploy that never set it): the host the request
 *   arrived on, so nobody is locked out of signing in.
 *
 * Pure: no imports, so the abuse cases in tests/ run it under `node --test`.
 */

/** The configured origins, normalised (`https://host[:port]`), in order. Never throws. */
export function configuredOrigins(raw: string | undefined = process.env.APP_ORIGIN): string[] {
  const origins: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      /* not a URL: skipped, and the warning below says so if nothing is left */
    }
  }
  if ((raw ?? "").trim() && origins.length === 0) {
    console.error("[app-origin] APP_ORIGIN is set but has no valid origin; using the request's own host");
  }
  return origins;
}

/** First entry of a possibly comma-separated proxy header, lowercased; null when empty. */
function firstValue(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  return first || null;
}

/**
 * The host the person's browser used, which is what the browser signs
 * (`window.location.host`). In a route handler that is, in order:
 *
 * 1. `x-forwarded-host`, which a reverse proxy sets to the public host when
 *    the app itself answers on an internal one (Next.js reads the app's own
 *    host from this header first, then `host`: see
 *    docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md).
 *    Vercel sets it and discards what the client sent;
 * 2. the `Host` header;
 * 3. the host in `request.url`, for a request built without headers.
 *
 * Only a fallback for when `APP_ORIGIN` is not set, and it only ever says
 * which deployment a proof is addressed to (lib/auth-message.ts is explicit
 * that this is not a phishing defence), so a spoofed value gains nothing:
 * whoever forges it signs with their own key.
 */
export function requestHost(request: Request): string | null {
  const forwarded = firstValue(request.headers.get("x-forwarded-host"));
  if (forwarded) return forwarded;
  const host = firstValue(request.headers.get("host"));
  if (host) return host;
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** `https://host` for the request, scheme from `x-forwarded-proto` when a proxy set it. */
export function requestOrigin(request: Request): string {
  const host = requestHost(request);
  const proto = firstValue(request.headers.get("x-forwarded-proto"));
  try {
    const own = new URL(request.url);
    const scheme = proto === "http" || proto === "https" ? proto : own.protocol.replace(":", "");
    return `${scheme}://${host ?? own.host}`;
  } catch {
    return `https://${host ?? "localhost"}`;
  }
}

/** Hosts a sign-in proof may be addressed to: the configured ones, or else the request's own. */
export function acceptedHosts(request: Request): string[] {
  const configured = configuredOrigins();
  if (configured.length > 0) return configured.map((origin) => new URL(origin).host);
  const host = requestHost(request);
  return host ? [host] : [];
}

/** The public origin for links we put in emails: the first configured one, else where the request arrived. */
export function publicOrigin(request: Request): string {
  return configuredOrigins()[0] ?? requestOrigin(request);
}
