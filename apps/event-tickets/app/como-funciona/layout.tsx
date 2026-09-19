import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cómo funciona",
  description:
    "Guía paso a paso de Pollar Pass: cómo comprar una entrada, cómo organizar un evento y preguntas frecuentes.",
};

export default function ComoFuncionaLayout({ children }: LayoutProps<"/como-funciona">) {
  return children;
}
