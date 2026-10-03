"use client";

import { AppShell } from "@/components/AppShell";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/lib/i18n/client";

/**
 * A screen's frame (band, title, back) with a spinner in it, for the moment
 * the session is still being restored. Returning nothing there left a blank
 * page that looked like a crash.
 */
export function ScreenLoading({ title, back }: { title: string; back: { href: string; label: string } }) {
  const t = useT();
  return (
    <AppShell title={title} back={back}>
      <div role="status" aria-label={t.common.loading} className="flex justify-center py-12">
        <Spinner />
      </div>
    </AppShell>
  );
}
