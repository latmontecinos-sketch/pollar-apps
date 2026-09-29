"use client";

import { PollarClient } from "@pollar/core";
import { PollarProvider } from "@pollar/react";
import { NETWORK } from "@/lib/network";
import "@pollar/react/styles.css";

const publishableKey = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY;

/**
 * Exactly ONE PollarClient per API key, kept on globalThis so it survives
 * React StrictMode double-initialization and dev hot reloads. Two live
 * clients share one persisted session and refresh independently; the
 * single-use refresh-token rotation then trips the server's reuse detection
 * and logs the user out (the SDK warns about exactly this).
 */
const globalPollar = globalThis as { __pollarClient?: PollarClient };

function getPollarClient(key: string): PollarClient {
  globalPollar.__pollarClient ??= new PollarClient({
    apiKey: key,
    // Publishable keys are network-scoped (pub_testnet_… / pub_mainnet_…).
    // lib/network.ts reads that same prefix and is where the expected USDC
    // issuer, Horizon and the explorer links come from too, so the SDK can't
    // end up on a different network than the one we verify payments against.
    stellarNetwork: NETWORK,
  });
  return globalPollar.__pollarClient;
}

/**
 * Single place where Pollar is initialized. Mounted once in app/layout.tsx;
 * everywhere else, consume Pollar via usePollar() from @pollar/react (or the
 * usePollarAuth() wrapper in hooks/usePollarAuth.ts). Never construct another
 * PollarClient.
 */
export function PollarAppProvider({ children }: { children: React.ReactNode }) {
  if (!publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY is not set. Copy .env.example to .env and paste your publishable key from dashboard.pollar.xyz (Build → API Keys)."
    );
  }

  return (
    <PollarProvider client={getPollarClient(publishableKey)}>
      {children}
    </PollarProvider>
  );
}
