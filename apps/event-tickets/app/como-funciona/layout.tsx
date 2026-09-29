import type { Metadata } from "next";
import { getDict } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDict();
  return { title: t.meta.guideTitle, description: t.meta.guideDescription };
}

export default function ComoFuncionaLayout({ children }: LayoutProps<"/como-funciona">) {
  return children;
}
