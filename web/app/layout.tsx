import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Nav } from "./nav";
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
          <div className="site-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true" />
              BREAKS
            </Link>
            <Nav />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
