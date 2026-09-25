"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useAppMode } from "@/hooks/useAppMode";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { modeForPath, type AppMode } from "@/lib/app-mode";
import { useT } from "@/lib/i18n/client";
import type { Dict } from "@/lib/i18n";

type Item = {
  href: string;
  icon: IconName;
  label: keyof Omit<Dict["nav"], "label">;
  /** Other routes that belong to this tab (an event's panel lives under "events"). */
  also?: string[];
};

/** Each mode's tabs (lib/app-mode.ts): a buyer never wades through the door scanner. */
const ITEMS: Record<AppMode, Item[]> = {
  explore: [
    { href: "/app", icon: "home", label: "home" },
    { href: "/mis-pases", icon: "ticket", label: "tickets" },
  ],
  organize: [
    { href: "/app", icon: "home", label: "home" },
    { href: "/mis-eventos", icon: "calendar", label: "events", also: ["/organizador/eventos"] },
    { href: "/escanear", icon: "scan", label: "scan" },
    { href: "/organizador/nuevo", icon: "plus", label: "create" },
  ],
};

function isActive(pathname: string, item: Item): boolean {
  return [item.href, ...(item.also ?? [])].some(
    (href) => pathname === href || (href !== "/app" && pathname.startsWith(`${href}/`))
  );
}

/**
 * The floating tab bar, with the tabs of the current mode. Signed out there
 * is nowhere to go yet, and on the mode chooser nothing is chosen yet, so
 * it stays hidden. A screen that belongs to one mode switches the app to it.
 */
export function BottomNav() {
  const { user } = usePollarAuth();
  const pathname = usePathname();
  const t = useT();
  const [stored, setMode] = useAppMode();
  const screenMode = modeForPath(pathname);

  useEffect(() => {
    if (user && screenMode && screenMode !== stored) setMode(screenMode);
  }, [user, screenMode, stored, setMode]);

  if (!user) return null;
  // Nothing chosen yet: the home shows the chooser, anywhere else (an event
  // opened from a link) reads as looking for events.
  const mode = screenMode ?? stored ?? (pathname === "/app" ? null : "explore");
  if (!mode) return null;

  return (
    <nav
      aria-label={t.nav.label}
      className="bottom-nav fixed inset-x-0 bottom-0 z-30 flex justify-center pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="flex w-full max-w-md items-center justify-around rounded-t-[2rem] bg-nav px-4 pt-3 pb-3 shadow-[0_-10px_30px_-20px_var(--foreground)] lg:max-w-lg">
        {ITEMS[mode].map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className="group flex flex-col items-center gap-1"
              >
                <span
                  className={`flex h-11 w-12 items-center justify-center rounded-2xl transition-all duration-150 group-active:scale-95 ${
                    active
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-foreground/75 group-hover:bg-tile-soft group-hover:text-tile-soft-foreground"
                  }`}
                >
                  <Icon name={item.icon} size={22} />
                </span>
                <span
                  className={`text-[11px] leading-none ${
                    active ? "font-semibold text-primary-text" : "font-medium text-muted"
                  }`}
                >
                  {t.nav[item.label]}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
