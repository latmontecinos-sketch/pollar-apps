import { NextResponse, type NextRequest } from "next/server";

/**
 * Content-Security-Policy with a per-request nonce.
 *
 * Why this app needs one: every action here is authorized by a SEP-53
 * signature that the page itself can mint (lib/auth-client.ts), and the
 * ticket codes are bearer credentials sitting in the DOM. A single injected
 * or compromised third-party script would be able to sign as the user and
 * read every ticket on screen. The nonce means only the scripts this server
 * rendered can run, and `strict-dynamic` lets those load Next's own chunks.
 *
 * Runs only on document requests (see `config.matcher`); the flat headers
 * that apply to everything, API routes included, live in next.config.ts.
 *
 * The file is `proxy.ts` and the export is `proxy` because Next 16 renamed
 * the `middleware` convention; the old name still works but warns on build.
 */

/** Edge runtime: no Buffer, so base64 comes from btoa over the random bytes. */
function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** Where the Pollar SDK and the Stellar network live — everything else is same-origin. */
const POLLAR_API = "https://sdk.api.pollar.xyz";
/**
 * The SDK's login modal pulls its logo from the marketing site, and that
 * URL 301s from the apex to www — CSP checks the redirect target too, so
 * both have to be here or the modal shows a broken image.
 */
const POLLAR_ASSETS = "https://pollar.xyz https://*.pollar.xyz";
const HORIZON = "https://horizon-testnet.stellar.org https://horizon.stellar.org";
const ALBEDO = "https://albedo.link";

/**
 * React's development build calls eval() to rebuild stack traces across the
 * server/client boundary. `next build` never does, so this relaxation exists
 * only while you're running `next dev`.
 */
const DEV_EVAL = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

function policy(nonce: string): string {
  return [
    "default-src 'self'",
    // strict-dynamic: trust is the nonce, not the URL. Next's bootstrap
    // script carries it and pulls in its own chunks from there.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${DEV_EVAL}`,
    // React writes style attributes and Tailwind injects a <style> in dev;
    // neither can be nonced, and a style injection can't sign or exfiltrate.
    "style-src 'self' 'unsafe-inline'",
    // data: for the QR the buyer sees in-app, blob: for the camera frames.
    `img-src 'self' data: blob: ${POLLAR_ASSETS}`,
    "font-src 'self'",
    `connect-src 'self' ${POLLAR_API} ${HORIZON} ${ALBEDO}`,
    // qr-scanner runs its decoder in a worker built from a blob.
    "worker-src 'self' blob:",
    `frame-src 'self' ${POLLAR_API} ${ALBEDO}`,
    "object-src 'none'",
    "base-uri 'none'",
    // Nobody frames us: the door screen has an "accept entry" button one
    // invisible iframe away from being clicked by someone else's page.
    "frame-ancestors 'none'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = policy(nonce);

  // Next reads the nonce back out of this request header and stamps it on
  // every script tag it renders.
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    /**
     * Documents only. Static assets are immutable and public, and API
     * responses are JSON or a PNG — a per-request nonce on those would
     * just make them uncacheable for nothing.
     */
    {
      source: "/((?!api|_next/static|_next/image|icon.svg|.well-known|.*\\.png$|.*\\.svg$).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
