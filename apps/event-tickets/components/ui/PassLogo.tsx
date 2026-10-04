import { PassMark } from "./PassMark";

/**
 * The Pollar Pass logo: the bear-and-ticket mark plus the wordmark, "Pollar"
 * in the app blue and "Pass" in ticket amber. The wordmark is live text in
 * the app's font (not a picture), so it stays sharp and is read as "Pollar
 * Pass". It is the brand's logotype, not copy, so it lives here and not in
 * lib/i18n.
 *
 * - `variant="band"` is for the brand band (white and amber over the blue).
 * - `layout="stacked"` puts the wordmark under the mark (heroes, 404).
 * - `wordmark={false}` draws the mark alone.
 *
 * The wordmark never goes below 20px bold: "Pass" is amber, and that pair
 * reaches 3:1 (large text) on the band and on the sheet, not 4.5:1.
 */
export function PassLogo({
  size = 32,
  variant = "color",
  layout = "inline",
  wordmark = true,
  wordmarkClassName = "",
  className = "",
}: {
  /** Height of the mark in px; the wordmark scales with it. */
  size?: number;
  variant?: "color" | "band";
  layout?: "inline" | "stacked";
  wordmark?: boolean;
  /** Extra classes for the wordmark alone (e.g. hide it on a crowded phone header). */
  wordmarkClassName?: string;
  className?: string;
}) {
  if (!wordmark) return <PassMark size={size} variant={variant} className={className} />;

  const onBand = variant === "band";
  const stacked = layout === "stacked";
  const fontSize = Math.max(20, Math.round(size * (stacked ? 0.3 : 0.6)));
  return (
    <span
      className={`inline-flex items-center ${stacked ? "flex-col gap-2" : "gap-2"} ${className}`}
    >
      <PassMark size={size} variant={variant} />
      <span
        className={`whitespace-nowrap font-extrabold leading-none tracking-tight ${wordmarkClassName}`}
        style={{ fontSize }}
      >
        <span className={onBand ? "text-band-foreground" : "text-primary-text"}>Pollar</span>{" "}
        <span className={onBand ? "text-ticket" : "text-pass"}>Pass</span>
      </span>
    </span>
  );
}
