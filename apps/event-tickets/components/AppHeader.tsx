"use client";

import { useState } from "react";
import Link from "next/link";
import { LoginButton } from "@/components/LoginButton";
import { NotificationsButton } from "@/components/NotificationsButton";
import { PreferencesModal } from "@/components/PreferencesModal";
import { Icon } from "@/components/ui/Icon";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useT } from "@/lib/i18n/client";

/** The round, light buttons that sit on the brand band. */
export const bandButton =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-background text-foreground/80 shadow-sm transition-colors hover:text-primary";

/**
 * The header inside the app shell's band: back (or the logo, home) on the
 * left; help, notifications, preferences and the account on the right; then
 * the screen's title in large type, the way the band opens every screen.
 */
export function AppHeader({
  title,
  subtitle,
  back,
}: {
  title?: string;
  subtitle?: string;
  back?: { href: string; label: string };
}) {
  const { user } = usePollarAuth();
  const t = useT();
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  return (
    <header className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        {back ? (
          <Link href={back.href} aria-label={back.label} title={back.label} className={bandButton}>
            <Icon name="back" size={18} />
          </Link>
        ) : (
          <Link href="/app" aria-label={t.common.home} className="flex min-w-0 items-center gap-2">
            <PollarLogo size={30} colorClass="bg-band-foreground" />
            <span className="truncate text-base font-bold tracking-tight">{t.common.appName}</span>
          </Link>
        )}
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/como-funciona" aria-label={t.common.help} title={t.common.help} className={bandButton}>
            <Icon name="help" size={18} />
          </Link>
          <NotificationsButton />
          <button
            onClick={() => setPreferencesOpen(true)}
            aria-label={t.common.preferences}
            title={t.common.preferences}
            className={bandButton}
          >
            <Icon name="settings" size={18} />
          </button>
          {user && <LoginButton />}
        </div>
      </div>
      {title && (
        <div className="flex flex-col gap-1">
          <h1 className="text-[1.65rem] font-bold leading-tight tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-band-foreground/80">{subtitle}</p>}
        </div>
      )}
      <PreferencesModal open={preferencesOpen} onClose={() => setPreferencesOpen(false)} />
    </header>
  );
}
