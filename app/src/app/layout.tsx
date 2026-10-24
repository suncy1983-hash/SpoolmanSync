import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import { IngressPatcher } from "@/components/ingress-patcher";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SpoolmanSync",
  description: "Automatic filament tracking for Bambu Lab and Creality printers with Spoolman",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // In HA ingress mode, activate the IngressPatcher to rewrite
  // fetch/navigation URLs through the ingress proxy
  const headersList = await headers();
  const ingressPath = headersList.get('x-ingress-path');

  return (
    <html lang="hu" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased overflow-x-hidden`}
      >
        <Providers>
          {ingressPath && <IngressPatcher ingressPath={ingressPath} />}
          {children}
          <footer className="w-full py-3 text-center text-xs text-muted-foreground/50">
            SpoolmanSync v{process.env.APP_VERSION}
          </footer>
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
