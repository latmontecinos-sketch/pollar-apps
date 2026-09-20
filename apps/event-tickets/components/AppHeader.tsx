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

/**
 * One header for every screen: logo (home), the screen title, an optional
 * "back" link to the parent screen, and on the right the help button
 * (→ /como-funciona), preferences (language and theme) and, when logged in,
 * the account button.
 */
export function AppHeader({
  title,
  back,
}: {
  title?: string;
  back?: { href: string; label: string };
}) {
  const { user } = usePollarAuth();
  const t = useT();
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  return (
    <header className="flex flex-col gap-1 py-2">
      {back && (
        <Link
          href={back.href}
          className="inline-flex w-fit items-center gap-1.5 rounded-lg py-1 text-sm font-medium text-muted transition-colors hover:text-primary"
        >
          <Icon name="back" size={16} />
          {back.label}
        </Link>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link href="/" aria-label={t.common.home} className="shrink-0">
            <PollarLogo size={30} />
          </Link>
          {title ? (
            <h1 className="min-w-0 truncate text-xl font-bold tracking-tight">{title}</h1>
          ) : (
            <Link href="/" className="text-base font-bold tracking-tight">
              {t.common.appName}
            </Link>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Link
            href="/como-funciona"
            aria-label={t.common.help}
            title={t.common.help}
            className="flex h-10 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm font-semibold text-muted transition-colors hover:bg-surface-hover hover:text-primary"
          >
            <Icon name="help" size={18} />
            <span className="hidden sm:inline">{t.common.help}</span>
          </Link>
          <NotificationsButton />
          <button
            onClick={() => setPreferencesOpen(true)}
            aria-label={t.common.preferences}
            title={t.common.preferences}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-muted transition-colors hover:bg-surface-hover hover:text-primary"
          >
            <Icon name="settings" size={18} />
          </button>
          {user && <LoginButton />}
        </div>
      </div>
      <PreferencesModal open={preferencesOpen} onClose={() => setPreferencesOpen(false)} />
    </header>
  );
}
