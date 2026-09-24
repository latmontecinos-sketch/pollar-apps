export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-3xl border border-border/70 bg-background p-6 shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}
