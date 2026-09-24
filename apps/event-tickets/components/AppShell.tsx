import { AppHeader } from "@/components/AppHeader";
import { BottomNav } from "@/components/BottomNav";

/**
 * Every in-app screen: a brand band on top (header, title and an optional
 * `hero` — balances, stats, the event's facts) and the content on a lighter
 * sheet with a deep top radius that rides up over the band. The bottom nav
 * appears on its own once someone is signed in.
 *
 * `.app-shell` is what app/globals.css keys the sheet-colored page and the
 * nav's bottom padding on, so nothing below the sheet shows a seam.
 */
export function AppShell({
  title,
  subtitle,
  back,
  hero,
  children,
}: {
  title?: string;
  subtitle?: string;
  back?: { href: string; label: string };
  hero?: React.ReactNode;
  children: React.ReactNode;
}) {
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
