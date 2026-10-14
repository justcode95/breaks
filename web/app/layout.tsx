import type { Metadata } from "next";
import Link from "next/link";
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
      <body>
        <header className="site">
          <nav aria-label="Main">
            <Link href="/">BREAKS</Link>
            <Link href="/verify">Verify a draw</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
