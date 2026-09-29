"use client";

import { useEffect, useState } from "react";
import { usePollar } from "@pollar/react";
import type { AuthState, PollarUserProfile, WalletInfo } from "@pollar/core";

export interface PollarUser {
  /** Stellar address: the user's stable id across every Pollar app. */
  address: string;
  /**
   * Email, name and avatar. Lives in memory only: null right after a page
   * reload until the SDK re-verifies the session with the server.
   */
  profile: PollarUserProfile | null;
  /** Full wallet info: custody, login provider, funding mode. */
  wallet: WalletInfo;
}

/** Steps where the SDK is waiting on the user, not working. See AuthState. */
const SETTLED_STEPS: AuthState["step"][] = [
  "idle",
  "authenticated",
  "error",
  "entering_email",
  "entering_code",
  "wallet_not_installed",
];

/**
 * Single auth entry point for apps built on this template.
 * Sessions persist in the SDK's own storage; after a reload the user is
 * restored automatically, no extra wiring needed.
 */
export function usePollarAuth(): {
  user: PollarUser | null;
  isLoading: boolean;
  login: () => void;
  logout: () => void;
  verified: boolean;
} {
  const { isAuthenticated, verified, wallet, logout, openLoginModal, getClient } =
    usePollar();
  const [authStep, setAuthStep] = useState<AuthState["step"]>("idle");

  useEffect(() => {
    // Fires immediately with the current state, then on every change;
    // returns its own unsubscribe function.
    return getClient().onAuthStateChange((state) => setAuthStep(state.step));
  }, [getClient]);

  const user: PollarUser | null =
    isAuthenticated && wallet
      ? { address: wallet.address, profile: getClient().getUserProfile(), wallet }
      : null;

  return {
    user,
    /** True while the SDK is mid-login (OAuth window, OTP check, wallet setup). */
    isLoading: !SETTLED_STEPS.includes(authStep),
    /** Opens Pollar's login modal (Google / GitHub / email OTP, per your dashboard config). */
    login: openLoginModal,
    logout,
    /** False while a restored session awaits server confirmation. Gate payments on this. */
    verified,
  };
}
