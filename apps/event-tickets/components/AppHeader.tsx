"use client";

import Link from "next/link";
import { LoginButton } from "@/components/LoginButton";
import { Icon } from "@/components/ui/Icon";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { usePollarAuth } from "@/hooks/usePollarAuth";

/**
 * One header for every screen: logo (home), the screen title, an optional
 * "back" link to the parent screen, and on the right the always-visible
 * help button (→ /como-funciona) plus the account button when logged in.
 */
export function AppHeader({
  title,
  back,
}: {
  title?: string;
  back?: { href: string; label: string };
}) {
  const { user } = usePollarAuth();

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
          <Link href="/" aria-label="Ir al inicio" className="shrink-0">
            <PollarLogo size={30} />
          </Link>
          {title ? (
            <h1 className="min-w-0 truncate text-xl font-bold tracking-tight">{title}</h1>
          ) : (
            <Link href="/" className="text-base font-bold tracking-tight">
              Pollar Pass
            </Link>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/como-funciona"
            aria-label="Cómo funciona"
            title="Cómo funciona"
            className="flex h-10 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm font-semibold text-muted transition-colors hover:bg-surface-hover hover:text-primary"
          >
            <Icon name="help" size={18} />
            <span className="hidden sm:inline">Ayuda</span>
          </Link>
          {user && <LoginButton />}
        </div>
      </div>
    </header>
  );
}
