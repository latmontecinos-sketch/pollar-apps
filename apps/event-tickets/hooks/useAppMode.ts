"use client";

import { useCallback, useSyncExternalStore } from "react";
import { modeCookie, modeFromCookies, type AppMode } from "@/lib/app-mode";

const CHANGE = "pase:mode";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE, onChange);
  return () => window.removeEventListener(CHANGE, onChange);
}

/**
 * The app mode (lib/app-mode.ts) and a setter. Every consumer — the home,
 * the bottom nav — re-renders on a change. `serverMode` is what the server
 * rendered with (read from the same cookie), so hydration matches; screens
 * that didn't get one start from null and settle right after.
 */
export function useAppMode(serverMode: AppMode | null = null): [AppMode | null, (mode: AppMode) => void] {
  const mode = useSyncExternalStore(
    subscribe,
    () => modeFromCookies(document.cookie),
    () => serverMode
  );
  const setMode = useCallback((next: AppMode) => {
    document.cookie = modeCookie(next, window.location.protocol === "https:");
    window.dispatchEvent(new Event(CHANGE));
  }, []);
  return [mode, setMode];
}
