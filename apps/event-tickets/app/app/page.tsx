import { cookies } from "next/headers";
import { connection } from "next/server";
import { APP_MODE_COOKIE, isAppMode } from "@/lib/app-mode";
import { listShowcase } from "@/lib/public-events";
import { parseShowcaseFilters } from "@/lib/showcase-filters";
import { AppHome } from "./AppHome";

/**
 * The app's home. Server-rendered so the showcase arrives with the page —
 * posters and all — instead of after a client round trip. `connection()`
 * keeps it a per-request render: the events come from the database, never
 * from whatever was there at build time. The mode cookie (lib/app-mode.ts)
 * comes along so the first paint is already the right home.
 *
 * The showcase's filters live in the query string (`?city=La+Paz&when=today`,
 * lib/showcase-filters.ts): the chips are links, the server does the
 * filtering, and anything unreadable in the URL falls back to "everything".
 */
export default async function AppPage({ searchParams }: PageProps<"/app">) {
  await connection();
  const stored = (await cookies()).get(APP_MODE_COOKIE)?.value;
  const filters = parseShowcaseFilters(await searchParams);
  const { events, cities } = await listShowcase(filters);
  return <AppHome events={events} cities={cities} filters={filters} initialMode={isAppMode(stored) ? stored : null} />;
}
