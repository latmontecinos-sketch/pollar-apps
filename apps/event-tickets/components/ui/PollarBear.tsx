/**
 * Placeholder Pollar mascot in the brand style: white polar bear with the
 * Pollar-blue outline and light-blue shading, sitting on a bit of ice.
 * Drawn with the --mascot tokens; swap for the official asset when it lands;
 * every usage goes through this component.
 */
export function PollarBear({ size = 48 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      {/* ice block */}
      <path
        d="M10 55l6-6h32l6 6-8 5H18l-8-5z"
        fill="var(--mascot-shade)"
        stroke="var(--mascot-outline)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* ears */}
      <circle cx="19" cy="16" r="6" fill="var(--mascot)" stroke="var(--mascot-outline)" strokeWidth="2.5" />
      <circle cx="45" cy="16" r="6" fill="var(--mascot)" stroke="var(--mascot-outline)" strokeWidth="2.5" />
      <circle cx="19" cy="16" r="2.5" fill="var(--mascot-shade)" />
      <circle cx="45" cy="16" r="2.5" fill="var(--mascot-shade)" />
      {/* head */}
      <ellipse
        cx="32"
        cy="31"
        rx="21"
        ry="19"
        fill="var(--mascot)"
        stroke="var(--mascot-outline)"
        strokeWidth="2.5"
      />
      {/* cheek shading */}
      <path
        d="M14.5 36c2.5 5 7 8.5 12 9.5-6.5 1.5-11.5-2-14-6.5z"
        fill="var(--mascot-shade)"
      />
      {/* eyes */}
      <circle cx="24.5" cy="28" r="2.6" fill="var(--mascot-features)" />
      <circle cx="39.5" cy="28" r="2.6" fill="var(--mascot-features)" />
      {/* muzzle */}
      <ellipse
        cx="32"
        cy="38.5"
        rx="9"
        ry="7"
        fill="var(--mascot)"
        stroke="var(--mascot-outline)"
        strokeWidth="2"
      />
      <path
        d="M28.6 36.5h6.8c0 2-1.5 3.4-3.4 3.4s-3.4-1.4-3.4-3.4z"
        fill="var(--mascot-features)"
      />
      <path
        d="M32 40v2.2m0 0c-1.2 1.5-3 1.9-4.4 1.1M32 42.2c1.2 1.5 3 1.9 4.4 1.1"
        stroke="var(--mascot-features)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
