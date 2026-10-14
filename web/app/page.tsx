import Link from "next/link";
import { LatestBreak } from "./latest-break";

export default function Home() {
  return (
    <main>
      <section className="hero">
        <h1>Collectible pack breaks, paid for by the coin.</h1>
        <p>
          Trading fees fund group breaks of collectible card packs on Solana. Anyone can take a paid spot, and holders of the coin get free spots, drawn by
          verifiable randomness. Devnet only: nothing is live yet.
        </p>
      </section>

      <LatestBreak />

      <h2>How it works</h2>
      <ol className="how">
        <li>Trading fees fill a public treasury reserve.</li>
        <li>When the reserve can fund a break, it opens automatically.</li>
        <li>Players buy paid spots in USDC; holders get free spots drawn by verifiable randomness.</li>
        <li>At the deadline, packs are bought and the pulled cards are randomly assigned to the spots.</li>
      </ol>

      <div className="callout">
        <p>
          Every draw can be checked: <Link href="/verify">recompute a break's winners and cards in your browser</Link>.
        </p>
      </div>
    </main>
  );
}
