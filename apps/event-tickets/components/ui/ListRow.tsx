import Link from "next/link";
import { Icon, type IconName } from "./Icon";

/** The three steps of brand blue an icon tile can take, soft → strong. */
export type TileTone = "soft" | "mid" | "strong";

const TILE: Record<TileTone, string> = {
  soft: "bg-tile-soft text-tile-soft-foreground",
  mid: "bg-tile-mid text-tile-foreground",
  strong: "bg-tile-strong text-tile-foreground",
};

export function IconTile({ icon, tone = "soft", size = 48 }: { icon: IconName; tone?: TileTone; size?: number }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-2xl ${TILE[tone]}`}
      style={{ width: size, height: size }}
    >
      <Icon name={icon} size={Math.round(size * 0.46)} />
    </span>
  );
}

/**
 * One line of a list: a colored icon tile, a title with a small accent line
 * under it, an optional `meta` column behind a hairline, and a chevron when
 * it leads somewhere.
 */
export function ListRow({
  href,
  icon,
  tone = "soft",
  title,
  subtitle,
  meta,
}: {
  href?: string;
  icon: IconName;
  tone?: TileTone;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  const body = (
    <>
      <IconTile icon={icon} tone={tone} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold">{title}</span>
        {subtitle && <span className="text-xs font-medium text-primary">{subtitle}</span>}
      </span>
      {meta && (
        <span className="shrink-0 border-l border-tile-soft pl-3 text-right text-sm font-semibold">{meta}</span>
      )}
      {href && <Icon name="chevron" size={18} className="shrink-0 text-muted-light" />}
    </>
  );
  const className = "flex items-center gap-3.5 rounded-2xl px-2 py-2.5";
  return href ? (
    <Link href={href} className={`${className} transition-colors hover:bg-background active:scale-[0.99]`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
