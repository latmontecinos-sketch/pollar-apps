import Link from "next/link";
import { PollarLogo } from "@/components/ui/PollarLogo";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-12 text-center">
      <PollarLogo size={72} />
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight">Página no encontrada</h1>
        <p className="max-w-sm text-sm text-muted">
          El link puede estar mal escrito o el evento ya no existe.
        </p>
      </div>
      <Link
        href="/"
        className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-all duration-150 hover:bg-primary-hover active:scale-[0.97]"
      >
        Volver al inicio
      </Link>
    </main>
  );
}
