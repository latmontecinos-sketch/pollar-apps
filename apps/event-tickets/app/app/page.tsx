import { connection } from "next/server";
import { listPublicEvents } from "@/lib/public-events";
import { AppHome } from "./AppHome";

/**
 * The app's home. Server-rendered so the showcase arrives with the page —
 * posters and all — instead of after a client round trip. `connection()`
 * keeps it a per-request render: the events come from the database, never
 * from whatever was there at build time.
 */
export default async function AppPage() {
  await connection();
  const events = await listPublicEvents();
  return <AppHome events={events} />;
}
