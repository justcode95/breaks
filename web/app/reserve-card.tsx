import type { Treasury } from "../lib/chain/treasury";
import { type BreakShape, type PackGroup, averagePackPrice, reserveProgress } from "../lib/chain/reserve";
import { money, percent as barWidth } from "../lib/chain/view";

/** "$20", or "nothing" for a bucket the break does not need. */
const need = (micro: bigint): string => (micro === 0n ? "nothing" : money(micro));

/** A machine as the keeper's settings name it: the text as it is, a raw 32-byte id shortened. React escapes the text. */
const machineName = (label: string): string => (/^0x[0-9a-fA-F]{64}$/.test(label) ? `${label.slice(0, 8)}…${label.slice(-4)}` : label);

/** "packs up to $25" when every pack may cost the same, otherwise each machine with how many packs come from it and its price. */
const packsText = (packs: readonly PackGroup[]): string =>
  packs.length === 1 ? `packs up to ${money((packs[0] as PackGroup).maxPrice)}` : `packs ${packs.map((g) => `${g.count} × ${machineName(g.machine)} up to ${money(g.maxPrice)}`).join(", ")}`;

/**
 * How far the reserve is from paying for the next break: a bar, the two buckets against what the break needs from each, and what is
 * still missing. The shape of the break is what the site was told (it is not on chain until the break exists), so the card says it.
 * Pure: the treasury and the shape come in.
 */
export function ReserveCard({ shape, treasury }: { shape: BreakShape; treasury: Pick<Treasury, "subsidy" | "holder"> }) {
  const r = reserveProgress(shape, { subsidy: treasury.subsidy.available, holder: treasury.holder.available });
  const lacking = [
    r.missing.subsidy > 0n ? `${money(r.missing.subsidy)} in the subsidy bucket` : "",
    r.missing.holder > 0n ? `${money(r.missing.holder)} in the holder bucket` : "",
  ].filter(Boolean);
  const buckets = [
    { name: "Subsidy bucket", have: r.available.subsidy, required: r.required.subsidy },
    { name: "Holder bucket", have: r.available.holder, required: r.required.holder },
  ];

  return (
    <section className="card reserve" aria-labelledby="reserve-title">
      <h2 id="reserve-title">Reserve for the next break</h2>
      <p className="reserve-percent">
        <span className="amount">{r.percent}%</span> of what the next break needs
      </p>
      <div className="bar" role="img" aria-label={`The reserve is at ${r.percent} percent of what the next break needs`}>
        <span style={{ width: `${barWidth(r.percent, 100)}%` }} />
      </div>
      <p>
        {r.enough
          ? "The reserve can pay for the next break. It opens by itself as soon as the sale before it has ended."
          : `The next break opens by itself once both buckets can pay for it. Still missing: ${lacking.join(" and ")}.`}
      </p>
      <dl>
        {buckets.map((b) => (
          <div key={b.name}>
            <dt>{b.name}</dt>
            <dd>
              {b.required === 0n ? "Nothing needed from this bucket." : `${money(b.have)} available of ${money(b.required)} needed.`}
            </dd>
          </div>
        ))}
      </dl>
      <p className="hint">
        Worst case for {shape.paidSpots} paid {shape.paidSpots === 1 ? "spot" : "spots"} at {money(shape.spotPrice)} and {shape.freeSpots} free{" "}
        {shape.freeSpots === 1 ? "spot" : "spots"}, with {packsText(shape.packs)}: the holder bucket must be able to pay every free spot at the average pack price,{" "}
        {money(averagePackPrice(shape))} ({need(r.required.holder)} in all), and the subsidy bucket the rest of what the packs cost beyond what the paid spots bring in (
        {need(r.required.subsidy)}). This is the shape the site was set up with for the next break.
      </p>
    </section>
  );
}
