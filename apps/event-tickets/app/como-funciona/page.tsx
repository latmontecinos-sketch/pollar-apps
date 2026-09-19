"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { BUYER_STEPS, GuideSteps, ORGANIZER_STEPS } from "@/components/GuideSteps";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";
import { usePollarAuth } from "@/hooks/usePollarAuth";

type Tab = "comprador" | "organizador" | "preguntas";

const TABS: { id: Tab; label: string }[] = [
  { id: "comprador", label: "Voy a un evento" },
  { id: "organizador", label: "Organizo" },
  { id: "preguntas", label: "Preguntas" },
];

const FLOW: { icon: IconName; label: string }[] = [
  { icon: "plus", label: "Crear" },
  { icon: "share", label: "Compartir" },
  { icon: "wallet", label: "Pagar" },
  { icon: "qr", label: "Entrar" },
];

/** Hash -> which tab to open (and which FAQ item, for #usdc etc.). */
function tabForHash(hash: string): Tab | null {
  const id = hash.replace(/^#/, "");
  if (id === "comprador" || id === "organizador" || id === "preguntas") return id;
  if (FAQ.some((item) => item.id === id)) return "preguntas";
  return null;
}

function CopyAddressButton() {
  const { user } = usePollarAuth();
  const [copied, setCopied] = useState(false);
  if (!user) {
    return <p className="text-xs text-muted">Primero ingresa con Pollar para tener tu dirección.</p>;
  }
  return (
    <Button
      variant="secondary"
      className="w-fit"
      onClick={() => {
        void navigator.clipboard.writeText(user.address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      <Icon name="copy" size={16} />
      {copied ? "Dirección copiada ✓" : "Copiar mi dirección"}
    </Button>
  );
}

const FAQ: { id: string; q: string; a: React.ReactNode }[] = [
  {
    id: "usdc",
    q: "¿Cómo consigo USDC de prueba para comprar?",
    a: (
      <div className="flex flex-col gap-3">
        <p>
          Esta demo usa la red de prueba de Stellar, así que los USDC son gratis y no tienen valor
          real. Circle (el emisor de USDC) regala 20 USDC de prueba cada 2 horas:
        </p>
        <ol className="flex list-decimal flex-col gap-1.5 pl-5">
          <li>Copia tu dirección de Pollar:</li>
        </ol>
        <CopyAddressButton />
        <ol start={2} className="flex list-decimal flex-col gap-1.5 pl-5">
          <li>
            Entra a{" "}
            <a
              href="https://faucet.circle.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-primary underline"
            >
              faucet.circle.com
            </a>
            .
          </li>
          <li>Elige la red <strong>Stellar Testnet</strong>, pega tu dirección y pide los USDC.</li>
          <li>Vuelve a Pollar Pass y toca “Actualizar” en tu saldo.</li>
        </ol>
      </div>
    ),
  },
  {
    id: "usdc-que-es",
    q: "¿Qué es USDC y por qué se paga así?",
    a: "USDC es un dólar digital: 1 USDC vale 1 dólar estadounidense. Se paga en la red Stellar, así que el dinero llega en segundos directo a la cuenta del organizador, con comisiones de centavos y sin banco intermedio.",
  },
  {
    id: "billetera",
    q: "¿Necesito una billetera cripto o instalar algo?",
    a: "No. Al ingresar con tu correo, Pollar crea tu cuenta y tu billetera. La misma cuenta y el mismo saldo sirven en todas las apps de Pollar.",
  },
  {
    id: "pague-sin-entrada",
    q: "Pagué pero no me apareció la entrada. ¿Qué hago?",
    a: (
      <p>
        No vuelvas a pagar. Ve a{" "}
        <Link href="/mis-pases" className="font-semibold text-primary underline">
          Mis entradas
        </Link>{" "}
        y toca “Ya pagué, verificar”: la app busca tu pago en la red de Stellar y emite tu entrada.
        A veces la red tarda unos segundos en registrarlo.
      </p>
    ),
  },
  {
    id: "reserva",
    q: "¿Qué pasa si no termino de pagar?",
    a: "Tu cupo queda reservado 15 minutos. Si no se completa el pago en ese tiempo, la reserva expira sola y el cupo vuelve a estar disponible. No se te cobra nada.",
  },
  {
    id: "dos-veces",
    q: "¿Alguien puede entrar con una captura de mi QR?",
    a: "Cada entrada vale una sola vez: apenas se escanea en la puerta queda marcada como usada, así que una copia no sirve. Por eso no compartas tu QR ni tu código de puerta.",
  },
  {
    id: "reembolso",
    q: "¿Puedo pedir un reembolso?",
    a: "Los pagos van directo al organizador, así que un reembolso depende de él: contáctalo. La app no retiene dinero.",
  },
  {
    id: "privacidad",
    q: "¿Qué datos míos ve el organizador?",
    a: "Solo tu dirección de Pollar (una cadena que empieza con G…) y el comprobante del pago. Tu correo no se muestra; solo se usa para mandarte tu entrada.",
  },
  {
    id: "puerta-staff",
    q: "Soy organizador: ¿otra persona puede validar en la puerta?",
    a: "Por ahora el modo puerta funciona con la cuenta que creó el evento. Lo más simple es abrirlo en el celular del organizador, con esa sesión iniciada.",
  },
];

export default function ComoFuncionaPage() {
  const [tab, setTab] = useState<Tab>("comprador");
  const [openFaq, setOpenFaq] = useState<string | null>(null);

  // Deep links: /como-funciona#usdc opens the FAQ tab on that question.
  useEffect(() => {
    function syncFromHash() {
      const hash = window.location.hash;
      const next = tabForHash(hash);
      if (!next) return;
      setTab(next);
      const id = hash.replace(/^#/, "");
      if (FAQ.some((item) => item.id === id)) {
        setOpenFaq(id);
        requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
      }
    }
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader title="Cómo funciona" back={{ href: "/", label: "Inicio" }} />

      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold tracking-tight">Pollar Pass en 30 segundos</h2>
          <p className="text-sm leading-6 text-muted">
            Una app para vender y comprar entradas de eventos pequeños. El organizador publica su
            evento y comparte un link; quien compra paga en USDC dentro de la app y recibe un QR que
            se valida una sola vez en la puerta.
          </p>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {FLOW.map((step, index) => (
            <div key={step.label} className="relative flex flex-col items-center gap-1.5 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-light text-primary">
                <Icon name={step.icon} size={20} />
              </span>
              <span className="text-xs font-semibold">{step.label}</span>
              {index < FLOW.length - 1 && (
                <Icon
                  name="chevron"
                  size={14}
                  className="absolute top-3.5 -right-2 text-muted-light"
                />
              )}
            </div>
          ))}
        </div>
      </Card>

      <div
        role="tablist"
        aria-label="Guía"
        className="grid grid-cols-3 gap-1 rounded-2xl border border-border bg-surface p-1"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => {
              setTab(item.id);
              history.replaceState(null, "", `#${item.id}`);
            }}
            className={`rounded-xl px-2 py-2.5 text-sm font-semibold transition-colors ${
              tab === item.id
                ? "bg-background text-primary shadow-sm"
                : "text-muted hover:text-foreground"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "comprador" && (
        <Card className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-bold tracking-tight">Comprar una entrada</h2>
            <p className="text-sm text-muted">Lo que vas a ver, paso a paso.</p>
          </div>
          <GuideSteps steps={BUYER_STEPS} />
          <div className="flex flex-col gap-2 rounded-xl border border-warning-border bg-warning-light p-4 text-sm leading-6">
            <p className="font-semibold text-warning">¿Tu saldo está en 0?</p>
            <p className="text-foreground">
              Para probar necesitas USDC de prueba.{" "}
              <a
                href="#usdc"
                className="font-semibold text-primary underline"
              >
                Así los consigues gratis
              </a>
              .
            </p>
          </div>
          <Link
            href="/mis-pases"
            className="flex h-12 items-center justify-center gap-2 rounded-xl border border-primary/30 text-sm font-semibold text-primary transition-colors hover:bg-primary-light"
          >
            <Icon name="ticket" size={18} />
            Ver mis entradas
          </Link>
        </Card>
      )}

      {tab === "organizador" && (
        <Card className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-bold tracking-tight">Organizar un evento</h2>
            <p className="text-sm text-muted">De crear el evento a recibir gente en la puerta.</p>
          </div>
          <GuideSteps steps={ORGANIZER_STEPS} />
          <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4 text-sm leading-6">
            <Icon name="shield" size={20} className="mt-0.5 text-primary" />
            <p className="text-muted">
              <span className="font-semibold text-foreground">Sin sobreventa ni entradas duplicadas.</span>{" "}
              Los cupos se reservan de forma atómica (dos personas nunca se quedan con el último
              lugar) y cada QR se marca como usado en el mismo instante en que se valida.
            </p>
          </div>
          <Link
            href="/organizador/nuevo"
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover"
          >
            <Icon name="plus" size={18} />
            Crear mi evento
          </Link>
        </Card>
      )}

      {tab === "preguntas" && (
        <div className="flex flex-col gap-2">
          {FAQ.map((item) => (
            <details
              key={item.id}
              id={item.id}
              open={openFaq === item.id}
              onToggle={(e) => {
                const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                setOpenFaq((current) => (isOpen ? item.id : current === item.id ? null : current));
              }}
              className="group scroll-mt-4 rounded-2xl border border-border bg-background shadow-sm"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 font-semibold leading-6">
                {item.q}
                <Icon
                  name="chevron"
                  size={18}
                  className="text-muted transition-transform group-open:rotate-90"
                />
              </summary>
              <div className="px-5 pb-5 text-sm leading-6 text-muted">{item.a}</div>
            </details>
          ))}
        </div>
      )}
    </main>
  );
}
