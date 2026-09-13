import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Captura — Scanner de imagens",
  description: "Encontre, selecione e baixe imagens de páginas públicas da web.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
