import type { Metadata } from "next";
import { TreasuryView } from "./treasury-view";

export const metadata: Metadata = {
  title: "Treasury · BREAKS",
  description: "How much is in the treasury, how it is split and who controls it, read from the chain.",
};

export default function TreasuryPage() {
  return (
    <main className="wide">
      <h1>Treasury</h1>
      <p>Trading fees fill a public reserve. Breaks are paid for out of it, and nothing else.</p>
      <TreasuryView />
    </main>
  );
}
