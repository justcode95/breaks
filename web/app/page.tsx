import Link from "next/link";
import { MachineArt } from "./icons";
import { LatestBreak } from "./latest-break";
import { NextBreak } from "./next-break";

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div>
          <p className="pill">Devnet only · nothing is live yet</p>
          <h1>
            Pack breaks, <span className="glow">paid for by the coin.</span>
          </h1>
          <p>
            Trading fees fund group breaks of collectible card packs on Solana. Anyone can take a paid spot, and holders of the coin get free spots, drawn by
            verifiable randomness.
          </p>
          <div className="actions">
            <Link href="/breaks" className="button">See the breaks</Link>
            <Link href="/verify" className="button secondary">Verify a draw</Link>
          </div>
        </div>
        <MachineArt />
      </section>

      <LatestBreak />
      <NextBreak />

      <h2>How it works</h2>
      <ol className="how">
        <li>Trading fees fill a public treasury reserve.</li>
        <li>When the reserve can fund a break, it opens automatically.</li>
        <li>Players buy paid spots in USDC; holders get free spots drawn by verifiable randomness.</li>
        <li>At the deadline, packs are bought and the pulled cards are randomly assigned to the spots.</li>
      </ol>
      <p>
        <Link href="/how-it-works">Read the longer version</Link>, including what you can check yourself and what you still have to trust.
      </p>

      <div className="callout">
        <p>
          Every draw can be checked: <Link href="/verify">recompute a break's winners and cards in your browser</Link>.
        </p>
      </div>
    </main>
  );
}
