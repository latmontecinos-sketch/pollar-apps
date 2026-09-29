"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useT } from "@/lib/i18n/client";

export function ReceiveModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { user } = usePollarAuth();
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
    <Modal open={open} onClose={onClose} title={t.account.receiveTitle}>
      <div className="flex flex-col gap-4">
        <p className="text-center text-sm leading-6 text-muted">{t.account.receiveBody}</p>
        <p className="break-all rounded-xl border border-border bg-surface px-4 py-4 text-center font-mono text-sm leading-6">
          {user.address}
        </p>
        <Button onClick={() => void copyAddress()} className="w-full py-3">
          {copied ? t.account.addressCopiedFull : t.account.copyAddress}
        </Button>
        <p className="text-center text-xs leading-5 text-muted">
          {t.account.receiveHintBefore}{" "}
          <Link
            href="/como-funciona#usdc"
            className="font-semibold text-primary underline"
            onClick={onClose}
          >
            {t.account.receiveHintLink}
          </Link>
        </p>
      </div>
    </Modal>
  );
}
