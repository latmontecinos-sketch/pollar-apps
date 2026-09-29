"use client";

import { useEffect, useRef } from "react";
import { usePollar } from "@pollar/react";
import type { WalletBalanceRecord } from "@pollar/core";

/**
 * The record the app treats as "the balance": the first app-enabled
 * non-native asset (the currency configured in the Pollar dashboard, e.g.
 * USDC), falling back to native XLM when the app has no asset configured.
 */
function primaryRecord(
  balances: WalletBalanceRecord[]
): WalletBalanceRecord | null {
  return (
    balances.find((b) => b.enabledInApp && b.type !== "native") ??
    balances.find((b) => b.type === "native") ??
    balances[0] ??
    null
  );
}

/**
 * Balance of the logged-in user, auto-fetched on login. Backed by the SDK's
 * shared `walletBalance` state: every component using this hook re-renders
 * when any of them calls `refresh()`.
 */
export function useBalance(): {
  /** Decimal string (e.g. "12.5000000"), null until loaded. */
  balance: string | null;
  /** Asset code of the balance shown, e.g. "USDC" or "XLM". */
  currency: string | null;
  /** The full balance record (type, issuer, available amount…). */
  asset: WalletBalanceRecord | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { isAuthenticated, verified, walletBalance, refreshWalletBalance } =
    usePollar();
  const retriedAfterVerify = useRef(false);

  // Wait for `verified`: right after a reload the session is restored
  // optimistically with a possibly stale token, and fetching then earns a
  // (harmless but noisy) 401 before the SDK refreshes and retries.
  useEffect(() => {
    if (!isAuthenticated || !verified) return;
    if (walletBalance.step === "idle") {
      void refreshWalletBalance();
    } else if (walletBalance.step === "error" && !retriedAfterVerify.current) {
      // A fetch that raced the re-validation may have failed; retry once.
      retriedAfterVerify.current = true;
      void refreshWalletBalance();
    }
  }, [isAuthenticated, verified, walletBalance.step, refreshWalletBalance]);

  const asset =
    walletBalance.step === "loaded"
      ? primaryRecord(walletBalance.data.balances)
      : null;

  return {
    balance: asset?.balance ?? null,
    currency: asset?.code ?? null,
    asset,
    isLoading:
      walletBalance.step === "loading" ||
      (isAuthenticated && walletBalance.step === "idle"),
    error: walletBalance.step === "error" ? walletBalance.message : null,
    refresh: refreshWalletBalance,
  };
}
