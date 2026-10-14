import { spotSlots } from "../../lib/chain/view";
import type { BreakAccount } from "../../lib/chain/accounts";
import { CheckIcon, StarIcon } from "../icons";

/** The spots of a break as a row of coins: pink ticks for paid spots taken, gold stars for the free spots of holders. */
export function SpotSlots({ b }: { b: BreakAccount }) {
  const slots = spotSlots(b);
  if (!slots) return null;
  const free = slots.filter((s) => s.kind === "free");
  const label = `${b.spotsSold} of ${b.paidSpots} paid spots taken, ${free.filter((s) => s.taken).length} of ${free.length} free spots awarded`;
  return (
    <div className="spots">
      <div className="slots" role="img" aria-label={label}>
        {slots.map((s, i) => (
          <span key={i} className={`slot ${s.kind} ${s.taken ? "taken" : "open"}`}>
            {s.kind === "free" ? <StarIcon /> : s.taken ? <CheckIcon /> : null}
          </span>
        ))}
      </div>
      <div className="key" aria-hidden="true">
        <span><i className="slot paid taken" /> Paid spot taken</span>
        <span><i className="slot paid open" /> Open</span>
        <span><i className="slot free taken" /> Free spot for a holder</span>
      </div>
    </div>
  );
}
