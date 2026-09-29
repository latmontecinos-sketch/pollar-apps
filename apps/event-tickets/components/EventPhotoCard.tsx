"use client";

import { useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { EventImagePicker } from "@/components/EventImagePicker";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { eventImagePath } from "@/lib/event-image-path";
import { useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";

/** Upload a JPEG the picker produced; the new version, or the error to show. */
export async function uploadEventPhoto(
  client: Parameters<typeof pollarFetch>[0],
  address: string,
  eventId: string,
  jpeg: Blob
): Promise<{ ok: true; version: string } | { ok: false; data: { error?: string; code?: string } }> {
  const res = await pollarFetch(client, address, `/api/events/${eventId}/image`, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: jpeg,
  });
  const data = (await res.json().catch(() => ({}))) as { version?: string; error?: string; code?: string };
  return res.ok && data.version ? { ok: true, version: data.version } : { ok: false, data };
}

/** The organizer panel's photo card: pick, frame, and it's live on the event page. */
export function EventPhotoCard({
  eventId,
  initialVersion,
  uploadFailed = false,
}: {
  eventId: string;
  initialVersion: string | null;
  /** Arrived from publishing, where the photo didn't make it up. */
  uploadFailed?: boolean;
}) {
  const t = useT();
  const { user } = usePollarAuth();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });
  const [version, setVersion] = useState(initialVersion);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(
    uploadFailed ? { tone: "error", text: t.eventImage.uploadLater } : null
  );

  async function upload(jpeg: Blob) {
    if (!user) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await uploadEventPhoto(pollarRef.current.getClient(), user.address, eventId, jpeg);
      if (result.ok) {
        setVersion(result.version);
        setMessage({ tone: "ok", text: t.eventImage.saved });
      } else {
        setMessage({ tone: "error", text: apiErrorMessage(t, result.data, t.eventImage.saveError) });
      }
    } catch {
      setMessage({ tone: "error", text: t.eventImage.saveError });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!user) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await pollarFetch(pollarRef.current.getClient(), user.address, `/api/events/${eventId}/image`, {
        method: "DELETE",
      });
      if (res.ok) setVersion(null);
      else setMessage({ tone: "error", text: t.eventImage.saveError });
    } catch {
      setMessage({ tone: "error", text: t.eventImage.saveError });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-bold">
        <Icon name="share" size={18} className="text-primary-text" />
        {t.eventImage.title}
      </h2>
      <EventImagePicker
        imageUrl={version ? eventImagePath(eventId, version) : null}
        busy={busy}
        onCropped={(jpeg) => void upload(jpeg)}
        onRemove={() => void remove()}
      />
      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={`rounded-xl border px-3 py-2 text-xs ${
            message.tone === "ok"
              ? "border-success-border bg-success-light text-success"
              : "border-error-border bg-error-light text-error"
          }`}
        >
          {message.text}
        </p>
      )}
    </Card>
  );
}
