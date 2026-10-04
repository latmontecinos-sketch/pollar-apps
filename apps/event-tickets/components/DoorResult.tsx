import { Icon, type IconName } from "@/components/ui/Icon";

/**
 * What the door says about a ticket. Five states, each a solid color with its
 * own text, big enough to read from an arm's length at a busy entrance:
 *
 * - `REVIEW`  amber: valid, but NOT yet registered. The person on the door still decides.
 * - `VALID`   green: the entry was registered, they can pass.
 * - `USED`    red: this ticket already got in.
 * - `UNKNOWN` red: no such ticket.
 * - `ERROR`   dark amber: the check itself failed (no signal, server error). Nothing was registered.
 *
 * Color is never the only signal: each has its own icon and its own words.
 * Purely visual (the scanner owns the logic); it fills its positioned parent.
 */
export type DoorResultKind = "REVIEW" | "VALID" | "USED" | "UNKNOWN" | "ERROR";

/** `ring` is the keyboard-focus color inside the result: its own text color, the one that already contrasts with its fill. */
const LOOK: Record<DoorResultKind, { box: string; badge: string; icon: IconName; ring: string }> = {
  REVIEW: { box: "bg-accent text-accent-foreground", badge: "bg-accent-foreground text-accent", icon: "qr", ring: "var(--accent-foreground)" },
  VALID: { box: "bg-success-solid text-on-success", badge: "bg-on-success text-success-solid", icon: "check", ring: "var(--on-success)" },
  USED: { box: "bg-error-solid text-on-error", badge: "bg-on-error text-error-solid", icon: "x", ring: "var(--on-error)" },
  UNKNOWN: { box: "bg-error-solid text-on-error", badge: "bg-on-error text-error-solid", icon: "x", ring: "var(--on-error)" },
  ERROR: { box: "bg-warning-solid text-on-warning", badge: "bg-on-warning text-warning-solid", icon: "alert", ring: "var(--on-warning)" },
};

/** The big buttons that go inside a result: solid, 56px, the same on every color. */
export const doorButton =
  "flex min-h-14 w-full items-center justify-center rounded-2xl px-5 text-lg font-bold transition-transform active:scale-[0.98] disabled:opacity-60";
export const doorButtonPrimary = `${doorButton} bg-foreground text-background`;
export const doorButtonSecondary = `${doorButton} bg-transparent ring-2 ring-current`;

export function DoorResult({
  kind,
  title,
  detail,
  doorCode,
  children,
}: {
  kind: DoorResultKind;
  title: string;
  detail: string;
  /** The ticket's short code, shown huge so it can be read back to the person. */
  doorCode?: string;
  /** The actions: "Accept / Cancel", or "Next". */
  children?: React.ReactNode;
}) {
  const look = LOOK[kind];
  return (
    <div
      // Same ARIA on the review as on the result: the screen reader hears what the screen shows.
      role="status"
      aria-live="assertive"
      style={{ "--focus": look.ring } as React.CSSProperties}
      // Scrolls instead of spilling out when the screen is short (a small phone, enlarged text).
      className={`pollar-rise absolute inset-0 flex flex-col items-center gap-4 overflow-y-auto rounded-3xl p-5 text-center ${look.box}`}
    >
      <span className="my-auto" />
      <span className={`pollar-pop flex h-16 w-16 shrink-0 items-center justify-center rounded-full min-[400px]:h-24 min-[400px]:w-24 ${look.badge}`}>
        <Icon name={look.icon} size={44} strokeWidth={3} />
      </span>
      <div className="flex flex-col gap-1.5">
        <p className="text-3xl font-extrabold leading-tight tracking-tight min-[400px]:text-4xl">{title}</p>
        <p className="mx-auto max-w-xs text-base font-medium leading-6">{detail}</p>
      </div>
      {doorCode && (
        <p className="rounded-2xl bg-foreground/10 px-5 py-2 font-mono text-3xl font-extrabold tracking-[0.25em]">
          {doorCode}
        </p>
      )}
      {children && <div className="mt-1 flex w-full max-w-xs flex-col gap-2">{children}</div>}
      <span className="my-auto" />
    </div>
  );
}
