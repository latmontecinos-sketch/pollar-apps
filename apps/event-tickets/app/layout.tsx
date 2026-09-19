import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { PollarAppProvider } from "@/lib/pollar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Pollar Pass — entradas con QR, pagadas en USDC",
    template: "%s · Pollar Pass",
  },
  description:
    "Vende y compra entradas para eventos pequeños en Bolivia. Pagas en USDC dentro de la app y entras con un QR que se valida una sola vez.",
  openGraph: { siteName: "Pollar Pass", locale: "es_BO", type: "website" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <PollarAppProvider>{children}</PollarAppProvider>
        <footer className="px-4 pb-6 pt-2 text-center text-xs leading-5 text-muted-light">
          Pollar Pass · demo en la red de prueba de Stellar (testnet): los USDC no tienen valor real ·{" "}
          <Link href="/como-funciona" className="underline hover:text-primary">
            Cómo funciona
          </Link>
        </footer>
      </body>
    </html>
  );
}
