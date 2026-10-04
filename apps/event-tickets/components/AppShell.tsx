import type { CSSProperties } from "react";
import { AppHeader } from "@/components/AppHeader";
import { BottomNav } from "@/components/BottomNav";

/** "band" is the organizer's look (brand band + sheet); "poster" is the public one (the page itself is tinted, no band). */
export type ShellTone = "band" | "poster";

/**
 * Every in-app screen. Two looks, one structure:
 *
 * - `tone="band"` (default, the organizer's side and every tool): a brand
 *   band on top (header, title and an optional `hero` — balances, stats) and
 *   the content on a lighter sheet with a deep top radius that rides up over
 *   the band.
 * - `tone="poster"` (the showcase and an event's page): no band. The page is
 *   a quiet wash (tinted with the event's color when `accent` is given, see
 *   app/globals.css `.event-tint`) so the posters carry the color, and the
 *   content gets room to go two columns on a desktop.
 *
 * The bottom nav appears on its own once someone is signed in.
 *
 * `.app-shell` is what app/globals.css keys the sheet-colored page and the
 * nav's bottom padding on, so nothing below the page shows a seam.
 */
export function AppShell({
  title,
  subtitle,
  back,
  hero,
  tone = "band",
  accent,
  children,
}: {
  title?: string;
  subtitle?: string;
  back?: { href: string; label: string };
  hero?: React.ReactNode;
  tone?: ShellTone;
  /** The inline variables of `accentStyle()` (lib/accent.ts); poster tone only. */
  accent?: CSSProperties | null;
  children: React.ReactNode;
}) {
  if (tone === "poster") {
    return (
      <div className="app-shell event-tint flex w-full flex-1 flex-col bg-tint" style={accent ?? undefined}>
        <div className="mx-auto w-full max-w-md px-4 pt-4 md:max-w-3xl lg:max-w-6xl">
          <AppHeader title={title} subtitle={subtitle} back={back} tone="poster" />
        </div>
        {hero && <div className="mx-auto w-full max-w-md px-4 pt-5 md:max-w-3xl lg:max-w-6xl">{hero}</div>}
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pt-5 pb-8 md:max-w-3xl lg:max-w-6xl">
          {children}
        </main>
        <BottomNav />
      </div>
    );
  }
  return (
    <div className="app-shell flex w-full flex-1 flex-col">
      <div className="bg-band text-band-foreground">
        <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pt-4 pb-14 lg:max-w-lg">
          <AppHeader title={title} subtitle={subtitle} back={back} />
          {hero}
        </div>
      </div>
      <main className="-mt-9 flex flex-1 flex-col rounded-t-[2.5rem] bg-sheet">
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pt-7 pb-6 lg:max-w-lg">
          {children}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
