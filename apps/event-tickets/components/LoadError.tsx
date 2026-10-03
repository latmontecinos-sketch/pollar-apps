"use client";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useT } from "@/lib/i18n/client";

/** A failed first load: what failed, and a way to try again without reloading the page. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <Card className="flex flex-col items-center gap-3 text-center">
      <p role="alert" className="text-sm text-error">{message}</p>
      <Button variant="secondary" onClick={onRetry}>
        {t.common.retry}
      </Button>
    </Card>
  );
}
