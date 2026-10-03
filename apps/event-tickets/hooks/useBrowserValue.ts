"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * A value that only exists in the browser (the origin, `navigator.share`):
 * `fallback` during SSR and hydration, the real thing right after. Nothing
 * here ever changes, so there is nothing to subscribe to.
 */
export function useBrowserValue<T>(read: () => T, fallback: T): T {
  return useSyncExternalStore(noopSubscribe, read, () => fallback);
}
