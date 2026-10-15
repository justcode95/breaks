import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How it works · BREAKS",
  description: "From a trading fee to a card in your wallet, what you can check yourself, and what you still have to trust.",
};

/**
 * The plain-language page. It describes the design as decided (CLAUDE.md, "Core rules") and says out loud what is still pending
 * or not built, so it does not promise more than exists. Words that sound like a promise of returns are kept out on purpose
 * (a test checks); the legal review is still open.
 */
export default function HowItWorksPage() {
  return (
    <main className="wide">
      <h1>How it works</h1>
      <p className="lede">
        Trading fees of the coin pay for group breaks of collectible card packs. This page follows one fee all the way to a card, then says what you can check
        yourself and what you still have to trust.
      </p>

      <div className="callout" role="note">
        <p>
          <strong>This is a test version.</strong> It runs on Solana devnet with test money only. Buying the packs and sending the cards are not connected to the
          real card service yet, and some of what is described below is designed but not built.
        </p>
      </div>

      <h2>From a fee to a card</h2>
      <ol className="how long">
        <li>
          <strong className="title">Fees fill the reserve.</strong>
          <p>
            Trading fees are collected by a multisig and swept into a public treasury that holds USDC only. The treasury keeps two buckets: one tops up the price of
            paid spots when a pack costs more than a spot, and the other pays for the free spots. The split is set by the admin multisig.
          </p>
          <Link href="/treasury">See the treasury</Link>
        </li>
        <li>
          <strong className="title">A break opens when the reserve can pay for it.</strong>
          <p>
            The reserve has to cover the worst case, which is every free spot plus the top-up of every paid spot, as if all of them sell. No team money is put in.
            Until the reserve is big enough, the next break waits. A break names its packs when it is created, from one machine or from several, and that list never
            changes.
          </p>
          <Link href="/breaks">See the breaks</Link>
        </li>
        <li>
          <strong className="title">Paid spots and free spots.</strong>
          <p>
            Anyone can buy a paid spot with USDC. Free spots go to holders of the coin. Holding is measured as the average balance over the whole sale, so buying a
            moment before the end counts for little, and your chance grows with that average (the rule for very large holders is still being decided). Liquidity
            pools, exchanges and team wallets are left out, and that list is meant to be public.
          </p>
          <Link href="/me">See your spots</Link>
        </li>
        <li>
          <strong className="title">At the deadline: fix the lists, then draw.</strong>
          <p>
            When the sale ends, the list of eligible wallets is fixed on chain as a fingerprint. One pack is bought and pulled for every spot that was filled (a paid
            spot nobody bought is simply not bought). A break lists its packs from the cheapest to the most expensive and the first ones are the ones bought, so a
            break that does not fill loses its most expensive packs. If the packs that would be bought are worth less than the spots cost on average, the break is
            cancelled before anything is bought and the spots are refunded. The list of pulled cards is fixed on chain the same way as the list of wallets. Only then is
            randomness requested, so nobody can know the answer before the lists are fixed. It picks the free-spot winners and shuffles the cards across all the spots.
          </p>
          <Link href="/verify">Check a draw</Link>
        </li>
        <li>
          <strong className="title">Cards go to the spots.</strong>
          <p>
            Each pulled card is sent to the wallet of the spot it was assigned to. If a break is cancelled before the packs are bought, every paid spot can be
            refunded to the wallet that bought it.
          </p>
          <Link href="/me">Refund a cancelled spot</Link>
        </li>
      </ol>

      <h2>What you can check yourself</h2>
      <ul>
        <li>
          <Link href="/treasury">The treasury</Link> shows what is held, what is reserved for breaks that exist and what is still free, read from the chain.
        </li>
        <li>
          <Link href="/breaks">Each break</Link> shows its sale, what was fixed before the draw (the eligible list's fingerprint, the cards' fingerprint and the
          seed) and the free winners recorded on chain.
        </li>
        <li>
          <Link href="/verify">Verify a draw</Link> recomputes the winners and who gets which card in your browser, with nothing sent anywhere.
        </li>
      </ul>
      <p>The pages read the chain directly from your browser. Nothing on them comes from a server of ours.</p>

      <h2>What you still have to trust</h2>
      <ul>
        <li>
          The chain cannot prove that the keeper really bought every pack or sent every card. A ledger that makes any gap visible, spot by spot, is planned.
        </li>
        <li>
          The randomness comes from ORAO, a separate service. You rely on its group of oracles and on whoever can upgrade its program.
        </li>
        <li>The card service's own randomness decides what is inside each pack. Ours only decides who gets which card.</li>
      </ul>

      <h2>Words</h2>
      <dl>
        <dt>Reserve</dt>
        <dd>The USDC in the treasury that pays for breaks.</dd>
        <dt>Break</dt>
        <dd>One round: a sale of spots, a draw, one pack per spot, and the cards sent out.</dd>
        <dt>Paid spot, free spot</dt>
        <dd>A paid spot is bought with USDC. A free spot goes to a holder, drawn at random.</dd>
        <dt>Average balance</dt>
        <dd>What a wallet held on average over the sale (a time-weighted average).</dd>
        <dt>Fingerprint</dt>
        <dd>A short code, fixed on chain, that anyone can recompute from the full list. If the list changes, the code changes.</dd>
      </dl>
    </main>
  );
}
