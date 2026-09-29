"use client";

/**
 * A pill-shaped switch between a few views of the same list. The selected
 * option fills with the brand color; the rest sit on a soft tile.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-full bg-tile-soft/70 p-1">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`flex-1 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              active ? "bg-primary text-primary-foreground shadow-sm" : "text-foreground/75 hover:text-primary"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
