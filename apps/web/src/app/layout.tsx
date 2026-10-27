import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "Steganography App",
  description: "Hide data in images and test how well it survives JPEG, resizing and blur.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl">
      <body className="min-h-dvh bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
