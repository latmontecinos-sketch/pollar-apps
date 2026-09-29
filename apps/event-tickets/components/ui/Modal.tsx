"use client";

import { useEffect, useRef } from "react";

const EXIT_MS = 300;

/**
 * Shared modal shell for the whole app: every modal goes through this one
 * component. On phones it's a bottom sheet (slides in and out through the
 * bottom edge); on desktop (sm+) it's a centered dialog. The backdrop blurs
 * the page. Built on the native <dialog> element (focus trap + Esc for free).
 *
 * Enter animation is pure CSS (`@starting-style`, see `.pollar-modal` in
 * globals.css). Exit is two-phase: add `.closing`, let the transition play,
 * then close(); a CSS-only exit is not reliable across engines.
 */
export function Modal({
  open,
  onClose,
  title,
  onBack,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Shows a back chevron on the left, for multi-step flows. */
  onBack?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      dialog.classList.remove("closing");
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (dialog.open) {
      dialog.classList.add("closing");
      const timer = setTimeout(() => {
        dialog.close();
        dialog.classList.remove("closing");
      }, EXIT_MS);
      return () => clearTimeout(timer);
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        // Esc: run the exit animation instead of the instant native close.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Only the backdrop is the <dialog> itself; inner clicks hit children.
        if (e.target === ref.current) onClose();
      }}
      className="pollar-modal m-0 mt-auto max-h-[88dvh] w-full max-w-full rounded-t-2xl border-border bg-background p-0 text-foreground shadow-xl sm:m-auto sm:max-w-md sm:rounded-2xl sm:border"
    >
      <div className="grid shrink-0 grid-cols-[2.75rem_1fr_2.75rem] items-center px-3 pt-4">
        {onBack ? (
          <button
            onClick={onBack}
            aria-label="Back"
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface hover:text-foreground"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <span />
        )}
        <h2 className="truncate text-center text-base font-bold tracking-tight">
          {title}
        </h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className="flex h-9 w-9 items-center justify-center justify-self-end rounded-full text-muted transition-colors hover:bg-surface hover:text-foreground"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="overflow-y-auto px-6 pb-6 pt-4">{children}</div>
    </dialog>
  );
}
