"use client";

import { useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { BalanceCard } from "@/components/BalanceCard";
import { BUYER_STEPS, GuideSteps } from "@/components/GuideSteps";
import { LoginButton } from "@/components/LoginButton";
import { ReceiveModal } from "@/components/ReceiveModal";
import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { useBalance } from "@/hooks/useBalance";
import { usePollarAuth } from "@/hooks/usePollarAuth";

const PROMISES: { icon: IconName; text: string }[] = [
  { icon: "wallet", text: "Sin billetera externa: ingresas con tu correo" },
  { icon: "shield", text: "Cada pago se verifica en la red Stellar" },
  { icon: "qr", text: "Cada QR vale una sola vez en la puerta" },
];

function ActionTile({
  href,
  icon,
  title,
  description,
  primary = false,
}: {
  href: string;
  icon: IconName;
  title: string;
  description: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-4 rounded-2xl border p-4 shadow-sm transition-all duration-150 active:scale-[0.98] ${
        primary
          ? "border-primary bg-primary text-primary-foreground hover:bg-primary-hover"
          : "border-border bg-background hover:border-primary/40 hover:bg-primary-light"
      }`}
    >
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
          primary ? "bg-primary-foreground/15" : "bg-primary-light text-primary"
        }`}
      >
        <Icon name={icon} size={22} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold">{title}</span>
        <span className={`text-sm ${primary ? "text-primary-foreground/80" : "text-muted"}`}>
          {description}
        </span>
      </span>
      <Icon name="chevron" size={18} className={primary ? "text-primary-foreground/70" : "text-muted-light"} />
    </Link>
  );
}

function Landing() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader />

      <section className="flex flex-col items-center gap-5 pt-4 text-center">
        <PollarLogo size={84} />
        <span className="rounded-full bg-primary-light px-3 py-1 text-xs font-semibold text-primary">
          Entradas digitales para eventos en Bolivia
        </span>
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight">
          Tu entrada es un QR.
          <span className="block text-primary">Tu pago, en USDC.</span>
        </h1>
        <p className="max-w-sm text-base leading-7 text-muted">
          Organiza un evento y vende entradas con un link, o compra la tuya en segundos. Todo
          dentro de la app, sin tarjetas ni billeteras externas.
        </p>
        <div className="flex w-full max-w-xs flex-col gap-2">
          <LoginButton label="Empezar con mi correo" className="w-full py-3.5 text-base" />
          <Link
            href="/como-funciona"
            className="rounded-xl py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary-light"
          >
            Ver cómo funciona →
          </Link>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3">
        <Card className="flex flex-col gap-2 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-light text-primary">
            <Icon name="ticket" />
          </span>
          <h2 className="font-semibold">¿Vas a un evento?</h2>
          <p className="text-sm leading-5 text-muted">Abre el link que te compartieron y compra tu entrada.</p>
        </Card>
        <Card className="flex flex-col gap-2 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-light text-primary">
            <Icon name="calendar" />
          </span>
          <h2 className="font-semibold">¿Organizas?</h2>
          <p className="text-sm leading-5 text-muted">Crea tu evento, comparte el link y valida en la puerta.</p>
        </Card>
      </div>

      <Card className="flex flex-col gap-5">
        <h2 className="text-lg font-bold tracking-tight">Así se compra una entrada</h2>
        <GuideSteps steps={BUYER_STEPS.slice(0, 4)} />
        <Link href="/como-funciona" className="text-sm font-semibold text-primary underline">
          Guía completa y preguntas frecuentes →
        </Link>
      </Card>

      <ul className="flex flex-col gap-2.5 px-1">
        {PROMISES.map((item) => (
          <li key={item.text} className="flex items-center gap-3 text-sm text-muted">
            <Icon name={item.icon} size={18} className="text-primary" />
            {item.text}
          </li>
        ))}
      </ul>
    </main>
  );
}

export default function Home() {
  const { user } = usePollarAuth();
  const { balance, isLoading } = useBalance();
  const [receiveOpen, setReceiveOpen] = useState(false);

  if (!user) return <Landing />;

  const emptyBalance = !isLoading && balance !== null && Number(balance) < 0.01;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader />

      <div className="flex flex-col gap-0.5 px-1">
        <h1 className="text-2xl font-bold tracking-tight">¿Qué quieres hacer hoy?</h1>
        <p className="text-sm text-muted">Compra entradas o administra tus eventos.</p>
      </div>

      <BalanceCard />

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setReceiveOpen(true)}
          className="flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface text-sm font-semibold transition-colors hover:bg-surface-hover"
        >
          <Icon name="wallet" size={17} className="text-primary" />
          Recibir USDC
        </button>
        <Link
          href="/como-funciona#usdc"
          className="flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface text-sm font-semibold transition-colors hover:bg-surface-hover"
        >
          <Icon name="plus" size={17} className="text-primary" />
          USDC de prueba
        </Link>
      </div>

      {emptyBalance && (
        <div className="flex items-start gap-3 rounded-2xl border border-warning-border bg-warning-light p-4 text-sm leading-6">
          <Icon name="alert" size={20} className="mt-0.5 text-warning" />
          <p>
            <span className="font-semibold">Tu saldo está en 0.</span> Para comprar entradas
            necesitas USDC. En esta demo son de prueba y{" "}
            <Link href="/como-funciona#usdc" className="font-semibold text-primary underline">
              los consigues gratis
            </Link>
            .
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3 pt-2">
        <ActionTile
          href="/mis-pases"
          icon="ticket"
          title="Mis entradas"
          description="Tus entradas compradas, con su QR"
          primary
        />
        <ActionTile
          href="/mis-eventos"
          icon="calendar"
          title="Mis eventos"
          description="Ventas, link para compartir y modo puerta"
        />
        <ActionTile
          href="/organizador/nuevo"
          icon="plus"
          title="Crear evento"
          description="Publica tu evento y empieza a vender"
        />
      </div>

      <Link
        href="/como-funciona"
        className="mt-2 flex items-center gap-3 rounded-2xl border border-dashed border-border p-4 text-sm transition-colors hover:border-primary/40 hover:bg-primary-light"
      >
        <Icon name="help" size={20} className="text-primary" />
        <span className="flex-1">
          <span className="font-semibold">¿Primera vez?</span>{" "}
          <span className="text-muted">Mira cómo funciona Pollar Pass, paso a paso.</span>
        </span>
        <Icon name="chevron" size={18} className="text-muted-light" />
      </Link>

      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </main>
  );
}
