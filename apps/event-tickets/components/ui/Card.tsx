/**
 * A caller's own padding (`p-0` for a full-bleed QR panel, `p-5` for a denser
 * row) replaces the default instead of competing with it: with both classes
 * on the element, whichever Tailwind happens to emit later wins, and here
 * that was always the default.
 */
const OWN_PADDING = /(^|\s)p-\S+/;

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const padding = OWN_PADDING.test(className) ? "" : "p-6";
  return (
    <div className={`rounded-3xl border border-border/70 bg-background shadow-sm ${padding} ${className}`}>
      {children}
    </div>
  );
}
