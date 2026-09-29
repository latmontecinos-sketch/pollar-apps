import type { NextConfig } from "next";

/**
 * Security headers that don't change per request. The Content-Security-Policy
 * is not here: it carries a per-request nonce, so it is built in proxy.ts.
 *
 * These apply to API responses too — an attacker who gets a browser to treat
 * our JSON as something executable doesn't care that it came from /api.
 */
const securityHeaders = [
  // No MIME sniffing: /api/tickets/[code]/qr returns bytes we say are a PNG.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Belt and braces with `frame-ancestors 'none'`, for anything that still
  // only understands the old header.
  { key: "X-Frame-Options", value: "DENY" },
  // Ticket codes travel inside URLs (the QR endpoint), so a full referrer
  // must never leave our origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    // The door and the event scanner need the camera; nothing here needs
    // anything else.
    value: [
      "camera=(self)",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "accelerometer=()",
      "gyroscope=()",
      "magnetometer=()",
      "browsing-topics=()",
    ].join(", "),
  },
  // Isolates our window from anything we open, while still letting a wallet
  // popup we opened talk back to us.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

const nextConfig: NextConfig = {
  // Don't advertise the framework and version to a scanner for free.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
