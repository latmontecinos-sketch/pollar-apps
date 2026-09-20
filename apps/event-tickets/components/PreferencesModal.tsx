"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { useLocale, useT } from "@/lib/i18n/client";
import { LOCALE_COOKIE, LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n/locales";
import { useTheme } from "@/lib/theme-client";
import { PREFERENCE_COOKIE_MAX_AGE, THEMES, type Theme } from "@/lib/theme";

function writePreference(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=${PREFERENCE_COOKIE_MAX_AGE}; samesite=lax`;
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="grid grid-cols-3 gap-1 rounded-2xl border border-border bg-surface p-1">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
            className={`rounded-xl px-2 py-2.5 text-sm font-semibold transition-colors ${
              value === option.id
                ? "bg-background text-primary shadow-sm"
                : "text-muted hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Language and light/dark, both kept in cookies so the server renders the
 * right language and theme on the very first paint (no flash, and shared
 * links keep working for whoever opens them).
 */
export function PreferencesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { theme, setTheme } = useTheme();

  function chooseLocale(next: Locale) {
    if (next === locale) return;
    writePreference(LOCALE_COOKIE, next);
    // Server components (event pages, metadata) re-render in the new language.
    startTransition(() => router.refresh());
  }

  const themeLabels: Record<Theme, string> = {
    system: t.common.themeSystem,
    light: t.common.themeLight,
    dark: t.common.themeDark,
  };

  return (
    <Modal open={open} onClose={onClose} title={t.common.preferences}>
      <div className="flex flex-col gap-6">
        <Segmented
          label={t.common.language}
          value={locale}
          onChange={chooseLocale}
          options={LOCALES.map((id) => ({ id, label: LOCALE_LABELS[id] }))}
        />
        <Segmented
          label={t.common.theme}
          value={theme}
          onChange={setTheme}
          options={THEMES.map((id) => ({ id, label: themeLabels[id] }))}
        />
      </div>
    </Modal>
  );
}
