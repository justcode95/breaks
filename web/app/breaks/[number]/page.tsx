import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BreakView } from "./break-view";

// A break's number is the on-chain id + 1, as in the X posts ("Break #3"). Anything else is not a break page.
const NUMBER = /^[1-9][0-9]{0,8}$/;

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }): Promise<Metadata> {
  const { number } = await params;
  if (!NUMBER.test(number)) return {};
  return { title: `Break #${number} · BREAKS`, description: `Where break #${number} stands, read from the chain.` };
}

export default async function BreakPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  if (!NUMBER.test(number)) notFound();
  return (
    <main className="wide">
      <BreakView number={Number(number)} />
    </main>
  );
}
