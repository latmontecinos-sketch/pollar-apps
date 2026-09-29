import { cookies } from "next/headers";
import { connection } from "next/server";
import { APP_MODE_COOKIE, isAppMode } from "@/lib/app-mode";
import { listPublicEvents } from "@/lib/public-events";
import { AppHome } from "./AppHome";

/**
 * The app's home. Server-rendered so the showcase arrives with the page —
 * posters and all — instead of after a client round trip. `connection()`
 * keeps it a per-request render: the events come from the database, never
 * from whatever was there at build time. The mode cookie (lib/app-mode.ts)
 * comes along so the first paint is already the right home.
 */
export default async function AppPage() {
  await connection();
  const stored = (await cookies()).get(APP_MODE_COOKIE)?.value;
  const events = await listPublicEvents();
  return <AppHome events={events} initialMode={isAppMode(stored) ? stored : null} />;
}
