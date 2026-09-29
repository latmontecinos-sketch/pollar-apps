/**
 * The app's two modes: looking for events (the showcase, your tickets) or
 * organizing them (your events, sales, the door). The choice is a per-browser
 * convenience, kept in a cookie so the server renders /app in the right mode
 * on the first paint — it guards nothing: every organizer route still checks
 * who is asking.
 */
export type AppMode = "explore" | "organize";

export const APP_MODE_COOKIE = "pase_mode";
const ONE_YEAR_S = 60 * 60 * 24 * 365;

export function isAppMode(value: unknown): value is AppMode {
  return value === "explore" || value === "organize";
}

/** The mode stored in a `Cookie` header or `document.cookie`, if any (and if it's a real one). */
export function modeFromCookies(cookies: string): AppMode | null {
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === APP_MODE_COOKIE) {
      const value = rest.join("=");
      return isAppMode(value) ? value : null;
    }
  }
  return null;
}

/** The `document.cookie` assignment that stores a mode for a year. */
export function modeCookie(mode: AppMode, secure: boolean): string {
  return `${APP_MODE_COOKIE}=${mode}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

// Not /puerta: door staff open it from a link the organizer shares, and they
// aren't organizers.
const ORGANIZER_ROUTES = ["/mis-eventos", "/organizador", "/escanear"];
const EXPLORER_ROUTES = ["/mis-pases"];

function under(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/**
 * The mode a screen belongs to, or null for screens both modes share (the
 * home, an event's page). Opening an organizer screen from anywhere — a link
 * in an email, the account menu — puts the app in organizer mode, so the
 * bottom nav always matches what's on screen.
 */
export function modeForPath(pathname: string): AppMode | null {
  if (ORGANIZER_ROUTES.some((route) => under(pathname, route))) return "organize";
  if (EXPLORER_ROUTES.some((route) => under(pathname, route))) return "explore";
  return null;
}
