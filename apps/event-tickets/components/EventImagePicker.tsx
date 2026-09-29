"use client";

import { useCallback, useRef, useState } from "react";
import Image from "next/image";
import Cropper, { type Area } from "react-easy-crop";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/lib/i18n/client";

/** Mirrors lib/event-image.ts (which imports the database, so it can't come to the browser). */
const WIDTH = 1080;
const HEIGHT = 1350;
/** Past this the upload is refused; aim well under it. */
const TARGET_BYTES = 700_000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("unreadable"));
    image.src = src;
  });
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), "image/jpeg", quality)
  );
}

/**
 * Draws exactly the framed area at 1080 × 1350 and encodes it as JPEG,
 * stepping the quality down until it's a comfortable size. The server
 * accepts nothing else, so what's framed here is what everyone sees.
 */
async function cropToJpeg(src: string, area: Area): Promise<Blob> {
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, WIDTH, HEIGHT);
  for (const quality of [0.86, 0.76, 0.66]) {
    const blob = await toJpeg(canvas, quality);
    if (blob.size <= TARGET_BYTES) return blob;
  }
  return toJpeg(canvas, 0.56);
}

/**
 * The event photo: recommended size up front, then a 4:5 frame to drag and
 * zoom (pinch on a phone) so it looks right where it'll be seen. It hands
 * back a ready JPEG; the caller decides when to upload it — right away in
 * the panel, after publishing when creating.
 */
export function EventImagePicker({
  imageUrl,
  busy = false,
  onCropped,
  onRemove,
}: {
  /** The current photo, or null for none. */
  imageUrl: string | null;
  busy?: boolean;
  onCropped: (jpeg: Blob) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const onCropComplete = useCallback((_: Area, pixels: Area) => setArea(pixels), []);

  function close() {
    if (source) URL.revokeObjectURL(source);
    setSource(null);
  }

  async function pick(file: File | undefined) {
    setError(null);
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      await loadImage(url); // HEIC outside Safari, a PDF renamed .jpg…
    } catch {
      URL.revokeObjectURL(url);
      setError(t.eventImage.unreadable);
      return;
    }
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setArea(null);
    setSource(url);
  }

  async function use() {
    if (!source || !area) return;
    setWorking(true);
    try {
      onCropped(await cropToJpeg(source, area));
      close();
    } catch {
      setError(t.eventImage.unreadable);
    } finally {
      setWorking(false);
    }
  }

  const lowRes = area !== null && area.width < WIDTH;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-4">
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy}
          aria-label={imageUrl ? t.eventImage.change : t.eventImage.choose}
          className="relative flex aspect-[4/5] w-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-tile-soft bg-field text-primary-text transition-colors hover:border-primary disabled:opacity-60"
        >
          {imageUrl ? (
            <Image src={imageUrl} alt="" fill sizes="112px" unoptimized className="object-cover" />
          ) : (
            <Icon name="plus" size={26} />
          )}
        </button>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs leading-5 text-muted">{t.eventImage.hint}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" loading={busy} onClick={() => input.current?.click()} className="px-4 py-2 text-xs">
              {imageUrl ? t.eventImage.change : t.eventImage.choose}
            </Button>
            {imageUrl && (
              <Button type="button" variant="ghost" disabled={busy} onClick={onRemove} className="px-3 py-2 text-xs">
                {t.eventImage.remove}
              </Button>
            )}
          </div>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        className="hidden"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = ""; // choosing the same file again must still fire
        }}
      />
      {error && (
        <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-xs text-error" role="alert">
          {error}
        </p>
      )}

      <Modal open={source !== null} onClose={close} title={t.eventImage.cropTitle}>
        {source && (
          <div className="flex flex-col gap-4">
            <p className="text-sm leading-6 text-muted">{t.eventImage.cropHelp}</p>
            <div className="relative mx-auto aspect-[4/5] w-full max-w-[20rem] overflow-hidden rounded-2xl bg-surface">
              <Cropper
                image={source}
                crop={crop}
                zoom={zoom}
                aspect={4 / 5}
                minZoom={1}
                maxZoom={4}
                showGrid
                objectFit="cover"
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            </div>
            <label className="flex items-center gap-3 text-sm font-medium">
              {t.eventImage.zoom}
              <input
                type="range"
                min={1}
                max={4}
                step={0.01}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="flex-1 accent-[var(--primary)]"
              />
            </label>
            {lowRes && (
              <p className="rounded-xl border border-warning-border bg-warning-light px-3 py-2 text-xs leading-5">
                {t.eventImage.lowRes}
              </p>
            )}
            <Button type="button" loading={working} disabled={!area} onClick={() => void use()} className="w-full">
              {t.eventImage.use}
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
