import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { IS_MAINNET } from "@/lib/network";
import { PollarAppProvider } from "@/lib/pollar";
import { I18nProvider } from "@/lib/i18n/client";
import { getDict, getTheme } from "@/lib/i18n/server";
import { themeAttribute } from "@/lib/theme";
import { ThemeProvider } from "@/lib/theme-client";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const { locale, t } = await getDict();
  return {
    title: { default: t.meta.title, template: `%s · ${t.common.appName}` },
    description: t.meta.description,
    openGraph: { siteName: t.common.appName, locale, type: "website" },
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Language and theme come from cookies, so the first paint is already
  // right — no flash of Spanish (or of white) before the client catches up.
  const [{ locale, t }, theme] = await Promise.all([getDict(), getTheme()]);

  return (
    <html
      lang={locale}
      data-theme={themeAttribute(theme)}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <I18nProvider locale={locale}>
          <ThemeProvider initial={theme}>
            <PollarAppProvider>{children}</PollarAppProvider>
          </ThemeProvider>
          <footer className="px-4 pb-6 pt-2 text-center text-xs leading-5 text-muted-light">
            {IS_MAINNET ? t.footer.disclaimerLive : t.footer.disclaimer}{" "}
            <Link href="/como-funciona" className="underline hover:text-primary">
              {t.footer.howItWorks}
            </Link>
          </footer>
        </I18nProvider>
      </body>
    </html>
  );
}
