import { PollarBear } from "./PollarBear";

/**
 * Playful empty state. The `icon` slot is where the official Pollar mascot
 * asset goes once it lands; until then it falls back to the placeholder
 * <PollarBear /> illustration.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-light">
        {icon ?? <PollarBear size={52} />}
      </div>
      <h3 className="text-lg font-bold tracking-tight">{title}</h3>
      {description && (
        <p className="max-w-xs text-sm leading-6 text-muted">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
