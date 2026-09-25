"use client";

import { useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";

/** One of the organizer's events, as app/api/events/mine returns it. */
export type MyEvent = {
  id: string;
  name: string;
  datetimeUtc: string;
  place: string;
  visibility: string;
  minPriceDecimal: string;
  maxPriceDecimal: string;
  capacity: number;
  reserved: number;
  paid: number;
  collectedDecimal: string;
};

export type MyEventsState = { step: "loading" } | { step: "loaded"; events: MyEvent[] } | { step: "error" };

/** The signed-in organizer's events, loaded once per address ("Mis eventos" and the organizer home). */
export function useMyEvents(): MyEventsState {
  const { user } = usePollarAuth();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });

  const [state, setState] = useState<MyEventsState>({ step: "loading" });
  const address = user?.address;

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      const client = pollarRef.current.getClient();
      const res = await pollarFetch(client, address, "/api/events/mine");
      if (cancelled) return;
      if (!res.ok) return setState({ step: "error" });
      const data = (await res.json()) as { events: MyEvent[] };
      setState({ step: "loaded", events: data.events });
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  return state;
}
