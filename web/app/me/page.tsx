import type { Metadata } from "next";
import { MySpots } from "./my-spots";

export const metadata: Metadata = {
  title: "My spots · BREAKS",
  description: "The paid spots a wallet bought and the free spots it won, read from the chain.",
};

export default function MePage() {
  return (
    <main className="wide">
      <h1>My spots</h1>
      <p>The spots your connected wallet has in the breaks, read straight from the chain.</p>
      <MySpots />
    </main>
  );
}
