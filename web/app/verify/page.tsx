import type { Metadata } from "next";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = {
  title: "Verify a draw · BREAKS",
  description: "Recompute a break's free-spot winners and card assignment from its published inputs, in your browser.",
};

export default function VerifyPage() {
  return (
    <main className="wide">
      <h1>Verify a draw</h1>
      <p>
        Every break's free spots and cards are given out by a fixed recipe over a random seed. Paste the published inputs
        here (or load a break from the chain) and your browser recomputes the winners and who gets which card. Nothing you
        paste leaves this page, and nothing is trusted: the answer comes only from the inputs.
      </p>
      <details>
        <summary>What this checks, and what it does not</summary>
        <ul>
          <li>
            The winners follow from the seed and the eligibility list, and the cards follow from the seed and the pool:
            the same recipe the program and the keeper use (the rules are in the project's documentation, with test vectors
            both sides must reproduce).
          </li>
          <li>
            That the inputs are the ones the break committed to: compare the root, the total weight, the number of wallets
            and the pool hash with the values on the break's account, and the winners with the ones recorded on it
            (loading the break from the chain fills these in, and the page compares them for you).
          </li>
          <li>
            Not checked here: that the seed really is what ORAO produced for this break, that the eligibility list follows
            from the token's holders, and that the cards were delivered. Those have their own public records.
          </li>
        </ul>
      </details>
      <VerifyForm />
    </main>
  );
}
