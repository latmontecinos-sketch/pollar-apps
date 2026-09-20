"use client";

import { useState } from "react";
import { AccountModal } from "@/components/AccountModal";
import { Button } from "@/components/ui/Button";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useT } from "@/lib/i18n/client";

/**
 * Logged out: the "sign in with Pollar" button (or a contextual `label`).
 * Logged in: a round account button that opens the account modal (email,
 * wallet address, log out).
 */
export function LoginButton({
  label,
  className = "",
}: {
  label?: string;
  className?: string;
} = {}) {
  const { user, isLoading, login } = usePollarAuth();
  const t = useT();
  const [accountOpen, setAccountOpen] = useState(false);

  if (user) {
    const initial = (user.profile?.mail?.[0] ?? "P").toUpperCase();
    return (
      <>
        <button
          onClick={() => setAccountOpen(true)}
          aria-label={t.account.accountLabel}
          title={user.profile?.mail ?? user.address}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-sm font-bold text-primary transition-colors hover:bg-surface-hover"
        >
          {initial}
        </button>
        <AccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
      </>
    );
  }

  return (
    <Button onClick={login} loading={isLoading} className={className}>
      {isLoading ? t.account.connecting : (label ?? t.account.login)}
    </Button>
  );
}
