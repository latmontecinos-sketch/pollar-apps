"use client";

import { useState } from "react";
import Link from "next/link";
import { bandButton } from "@/components/band-button";
import { PreferencesModal } from "@/components/PreferencesModal";
import { Icon } from "@/components/ui/Icon";
import { PassLogo } from "@/components/ui/PassLogo";
import { useT } from "@/lib/i18n/client";

/** Header of the public product page, on its brand band: brand, preferences, and the way in. */
export function ProductHeader() {
  const t = useT();
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  return (
    <header className="flex items-center justify-between gap-3 py-4">
      <Link href="/" className="flex items-center gap-2.5">
        <PassLogo size={32} variant="band" />
      </Link>
      <div className="flex items-center gap-2">
        <Link
          href="/como-funciona"
          className="hidden h-10 items-center rounded-full px-3 text-sm font-semibold text-band-foreground/80 transition-colors hover:text-band-foreground sm:flex"
        >
          {t.footer.howItWorks}
        </Link>
        <button
          onClick={() => setPreferencesOpen(true)}
          aria-label={t.common.preferences}
          title={t.common.preferences}
          className={bandButton}
        >
          <Icon name="settings" size={18} />
        </button>
        <Link
          href="/app"
          className="flex h-10 items-center gap-2 whitespace-nowrap rounded-full bg-background px-4 text-sm font-semibold text-primary shadow-sm transition-colors hover:bg-primary-light"
        >
          {t.product.openApp}
          <Icon name="chevron" size={16} />
        </Link>
      </div>
      <PreferencesModal open={preferencesOpen} onClose={() => setPreferencesOpen(false)} />
    </header>
  );
}
