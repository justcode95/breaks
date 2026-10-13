import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// BREAKS is a placeholder name until the coin name is decided (see CLAUDE.md, "Open decisions").
export const metadata: Metadata = {
  title: "BREAKS",
  description: "Token-gated collectible pack breaks on Solana.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
