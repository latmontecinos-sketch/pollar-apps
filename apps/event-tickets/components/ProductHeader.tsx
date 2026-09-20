"use client";

import { useState } from "react";
import Link from "next/link";
import { PreferencesModal } from "@/components/PreferencesModal";
import { Icon } from "@/components/ui/Icon";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { useT } from "@/lib/i18n/client";

/** Header of the public product page: brand, preferences, and the way in. */
export function ProductHeader() {
  const t = useT();
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  return (
    <header className="flex items-center justify-between gap-3 py-4">
      <Link href="/" className="flex items-center gap-2.5">
        <PollarLogo size={32} />
        <span className="text-lg font-bold tracking-tight">{t.common.appName}</span>
      </Link>
      <div className="flex items-center gap-2">
        <Link
          href="/como-funciona"
          className="hidden h-10 items-center rounded-full px-3 text-sm font-semibold text-muted transition-colors hover:text-primary sm:flex"
        >
          {t.footer.howItWorks}
        </Link>
        <button
          onClick={() => setPreferencesOpen(true)}
          aria-label={t.common.preferences}
          title={t.common.preferences}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-muted transition-colors hover:bg-surface-hover hover:text-primary"
        >
          <Icon name="settings" size={18} />
        </button>
        <Link
          href="/app"
          className="flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover"
        >
          {t.product.openApp}
          <Icon name="chevron" size={16} />
        </Link>
      </div>
      <PreferencesModal open={preferencesOpen} onClose={() => setPreferencesOpen(false)} />
    </header>
  );
}
