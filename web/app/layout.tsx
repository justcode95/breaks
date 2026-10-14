import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CapsuleIcon } from "./icons";
import { Nav } from "./nav";
import { WalletButton } from "./wallet-button";
import { WalletProvider } from "../lib/wallet/provider";
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
        <WalletProvider>
          <header className="site">
            <div className="site-inner">
              <Link href="/" className="brand">
                <CapsuleIcon />
                BREAKS
              </Link>
              <Nav />
              <WalletButton />
            </div>
          </header>
          {children}
        </WalletProvider>
      </body>
    </html>
  );
}
