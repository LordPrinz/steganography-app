import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer.tsx";
import { SiteHeader } from "@/components/site-header.tsx";
import { cn } from "@/lib/utils.ts";
import { Providers } from "./providers.tsx";
import "./globals.css";

const geist = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: { default: "Steganography App", template: "%s · Steganography App" },
  description: "Hide data in images and test how well it survives JPEG, resizing and blur.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // next-themes sets the theme class on <html> before hydration.
    <html lang="pl" className={cn("font-sans", geist.variable)} suppressHydrationWarning>
      <body className="flex min-h-dvh flex-col antialiased">
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:py-12">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
