import { Icon, type IconName } from "./Icon";

/** A figure on the band: icon, small label, big number. Hero rows use two or three of them. */
export function Stat({ icon, label, value }: { icon: IconName; label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5 rounded-2xl bg-background px-2 py-3 text-foreground shadow-sm">
      <Icon name={icon} size={20} className="text-primary-text" />
      <span className="truncate text-xs font-medium text-muted">{label}</span>
      <span className="truncate text-2xl font-bold tabular-nums">{value}</span>
    </div>
  );
}
