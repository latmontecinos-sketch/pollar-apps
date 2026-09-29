"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { middleTruncate } from "@/lib/format";
import { useT } from "@/lib/i18n/client";

export function AccountModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { user, logout } = usePollarAuth();
  const t = useT();
  const [copied, setCopied] = useState(false);

  if (!user) return null;

  async function copyAddress() {
    if (!user) return;
    await navigator.clipboard.writeText(user.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Modal open={open} onClose={onClose} title={t.account.accountLabel}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <span className="text-sm text-muted">{t.account.email}</span>
            <span className="min-w-0 truncate text-sm font-medium">
              {user.profile?.mail ?? "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <span className="text-sm text-muted">{t.account.wallet}</span>
            <button
              onClick={() => void copyAddress()}
              title={user.address}
              className="font-mono text-sm font-medium text-primary transition-colors hover:text-primary-hover"
            >
              {copied ? t.account.addressCopied : middleTruncate(user.address, 6, 6)}
            </button>
          </div>
        </div>

        <button
          onClick={() => {
            logout();
            onClose();
          }}
          className="w-full rounded-xl border border-error-border py-2.5 text-sm font-semibold text-error transition-colors hover:bg-error-light"
        >
          {t.account.logout}
        </button>
      </div>
    </Modal>
  );
}
