import { Icon, type IconName } from "@/components/ui/Icon";

export type GuideStep = { icon: IconName; title: string; body: React.ReactNode };

/** Numbered vertical timeline: the shared "paso a paso" layout of the guide and the landing. */
export function GuideSteps({ steps }: { steps: GuideStep[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => (
        <li key={step.title} className="relative flex gap-4 pb-6 last:pb-0">
          {index < steps.length - 1 && (
            <span aria-hidden="true" className="absolute top-11 bottom-1 left-5 w-px bg-border" />
          )}
          <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary">
            <Icon name={step.icon} size={19} />
            <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
              {index + 1}
            </span>
          </span>
          <div className="flex min-w-0 flex-col gap-1 pt-1.5">
            <h3 className="font-semibold leading-6">{step.title}</h3>
            <div className="text-sm leading-6 text-muted">{step.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export const BUYER_STEPS: GuideStep[] = [
  {
    icon: "share",
    title: "Abre el link del evento",
    body: "El organizador comparte un link (por WhatsApp, redes, etc.). Ahí ves fecha, lugar, precio y cupos disponibles. No necesitas cuenta para mirar.",
  },
  {
    icon: "wallet",
    title: "Ingresa con tu correo",
    body: "Tocas “Ingresar” y Pollar te crea una cuenta con billetera automáticamente. No instalas nada ni guardas frases secretas.",
  },
  {
    icon: "ticket",
    title: "Compra tu entrada",
    body: "Revisas el precio y confirmas. Tu cupo queda reservado 15 minutos mientras se procesa el pago en USDC, que va directo al organizador.",
  },
  {
    icon: "qr",
    title: "Recibe tu QR",
    body: "Tu entrada aparece al instante con un código QR y un código corto de puerta. Queda guardada en “Mis entradas” y te llega por correo.",
  },
  {
    icon: "check",
    title: "Muéstralo en la puerta",
    body: "El organizador escanea tu QR (o escribe tu código de puerta). Cada entrada vale una sola vez.",
  },
];

export const ORGANIZER_STEPS: GuideStep[] = [
  {
    icon: "plus",
    title: "Crea tu evento",
    body: "Nombre, lugar, fecha, precio en USDC y cupo total. El precio y el cupo quedan fijos después de publicar, para no afectar a quien ya compró.",
  },
  {
    icon: "share",
    title: "Comparte el link",
    body: "Desde el panel del evento copias el link, lo mandas por WhatsApp o muestras su QR en un afiche.",
  },
  {
    icon: "wallet",
    title: "Cobra directo en USDC",
    body: "Cada compra es un pago del comprador a tu cuenta Pollar. La app verifica cada pago en la red de Stellar antes de emitir la entrada — no hay intermediario que retenga tu dinero.",
  },
  {
    icon: "chart",
    title: "Sigue tus ventas",
    body: "En “Ventas” ves lo recaudado, cada pago con su comprobante y quién ya ingresó.",
  },
  {
    icon: "scan",
    title: "Valida en la puerta",
    body: "El día del evento abre “Modo puerta” en tu celular y escanea los QR. Verde: puede pasar. Rojo: ya usada o no válida.",
  },
];
