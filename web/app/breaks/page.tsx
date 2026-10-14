import type { Metadata } from "next";
import { BreakList } from "./break-list";

export const metadata: Metadata = {
  title: "Breaks · BREAKS",
  description: "Every break the program has made, newest first, read from the chain.",
};

export default function BreaksPage() {
  return (
    <main className="wide">
      <h1>Breaks</h1>
      <BreakList />
    </main>
  );
}
