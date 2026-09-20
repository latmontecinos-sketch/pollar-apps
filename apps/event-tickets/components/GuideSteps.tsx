import { Icon, type IconName } from "@/components/ui/Icon";
import type { Dict } from "@/lib/i18n";

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

/** Icons stay here; the words come from the reader's dictionary. */
const BUYER_ICONS: IconName[] = ["share", "wallet", "ticket", "qr", "check"];
const ORGANIZER_ICONS: IconName[] = ["plus", "share", "wallet", "chart", "scan"];

export function buyerSteps(t: Dict): GuideStep[] {
  return t.guide.buyerSteps.map((step, index) => ({ icon: BUYER_ICONS[index], ...step }));
}

export function organizerSteps(t: Dict): GuideStep[] {
  return t.guide.organizerSteps.map((step, index) => ({ icon: ORGANIZER_ICONS[index], ...step }));
}
