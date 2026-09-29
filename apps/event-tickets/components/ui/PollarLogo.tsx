/**
 * Official Pollar logo (the "P" with the polar bear in negative space),
 * from public/pollar-logo-light.svg. Rendered as a CSS mask painted with the
 * --logo token, so it's brand blue on light and near-white on dark: one
 * asset, no variant swapping (public/pollar-logo-dark.svg stays available
 * for contexts where a mask won't do, e.g. emails or og-images).
 */
export function PollarLogo({
  size = 28,
  colorClass = "bg-logo",
  className = "",
}: {
  size?: number;
  /** Token-backed background class that paints the mask, e.g. "bg-primary-foreground/10". */
  colorClass?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 ${colorClass} ${className}`}
      style={{
        width: size,
        height: size,
        maskImage: "url(/pollar-logo-light.svg)",
        WebkitMaskImage: "url(/pollar-logo-light.svg)",
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}
