"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useT } from "@/lib/i18n/client";
import type { Dict } from "@/lib/i18n";

type Item = {
  href: string;
  icon: IconName;
  label: keyof Omit<Dict["nav"], "label">;
  /** Other routes that belong to this tab (an event's panel lives under "events"). */
  also?: string[];
};

const ITEMS: Item[] = [
  { href: "/app", icon: "home", label: "home" },
  { href: "/mis-pases", icon: "ticket", label: "tickets" },
  { href: "/escanear", icon: "scan", label: "scan" },
  { href: "/mis-eventos", icon: "calendar", label: "events", also: ["/organizador/eventos"] },
  { href: "/organizador/nuevo", icon: "plus", label: "create" },
];

function isActive(pathname: string, item: Item): boolean {
  return [item.href, ...(item.also ?? [])].some(
    (href) => pathname === href || (href !== "/app" && pathname.startsWith(`${href}/`))
  );
}

/** The floating tab bar. Signed out there is nowhere to go yet, so it stays hidden. */
export function BottomNav() {
  const { user } = usePollarAuth();
  const pathname = usePathname();
  const t = useT();
  if (!user) return null;

  return (
    <nav
      aria-label={t.nav.label}
      className="bottom-nav fixed inset-x-0 bottom-0 z-30 flex justify-center pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="flex w-full max-w-md items-center justify-between rounded-t-[2rem] bg-nav px-4 pt-3 pb-3 shadow-[0_-10px_30px_-20px_var(--foreground)] lg:max-w-lg">
        {ITEMS.map((item) => {
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
                    active ? "font-semibold text-primary" : "font-medium text-muted"
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
