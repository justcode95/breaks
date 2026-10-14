// The snapshot the bot decides from: finalized chain state plus the few facts only the keeper's database holds.

import type { AccountReader } from "../pipeline/chain.js";
import { type BreakTemplate, templateProblem } from "../scheduler/policy.js";
import { TreasuryNotInitialized, readReserve } from "../scheduler/reserve.js";
import { type BreakAccount, type Programs, breakAddress, configAddress, decodeBreak, decodeBreaksConfig } from "../solana/breaks.js";
import type { Address } from "../solana/pubkey.js";
import type { Commitment, RpcClient } from "../solana/rpc.js";
import type { World } from "./policy.js";
import type { BotStore } from "./store.js";

export interface WorldReader {
  read(now: Date): Promise<Omit<World, "keys">>;
}

/** Reads accounts at one commitment. The bot reads at `finalized`, whatever the keeper's own sends wait for. */
export class RpcAccountReader implements AccountReader {
  constructor(
    private readonly rpc: RpcClient,
    private readonly commitment: Commitment,
  ) {}

  async getAccountData(address: Address): Promise<Uint8Array | undefined> {
    return (await this.rpc.getAccountInfo(address, { commitment: this.commitment }))?.data;
  }
}

export interface ChainWorldDeps {
  /** Must read at `finalized`: nothing is announced that could still roll back. */
  chain: AccountReader;
  programs: Programs;
  /** The break the keeper is configured to create: the reserve is measured against it. */
  template: BreakTemplate;
  store: BotStore;
  /** How many of the latest breaks are looked at. */
  lookback: number;
}

export class ChainWorld implements WorldReader {
  constructor(private readonly deps: ChainWorldDeps) {}

  async read(now: Date): Promise<Omit<World, "keys">> {
    const { chain, programs, template, store, lookback } = this.deps;
    const raw = await chain.getAccountData(configAddress(programs));
    // The breaks program is not initialized yet: nothing to say.
    if (!raw) return { now, breaks: [], handles: new Map(), delivered: [] };
    const config = decodeBreaksConfig(raw);

    const breaks: BreakAccount[] = [];
    for (let id = config.nextBreakId > BigInt(lookback) ? config.nextBreakId - BigInt(lookback) : 0n; id < config.nextBreakId; id++) {
      const data = await chain.getAccountData(breakAddress(programs, id));
      if (data) breaks.push(decodeBreak(data));
    }

    // How far the next break is. Not said while the program is paused or would refuse the configured break.
    let reserve: World["reserve"];
    if (!config.paused && templateProblem(template, config) === undefined) {
      // A treasury that does not exist yet is "nothing to say"; a node that fails is an error and the run is repeated.
      const p = await readReserve(chain, programs, template).catch((err: unknown) => {
        if (err instanceof TreasuryNotInitialized) return undefined;
        throw err;
      });
      if (p) reserve = { nextBreakId: config.nextBreakId, percent: p.percent, enough: p.enough, target: p.requiredSubsidy + p.requiredHolder };
    }

    const winners = breaks.filter((b) => b.status === "Drawn").flatMap((b) => b.freeWinners.slice(0, b.freeWinnerCount).map((w) => w.wallet));
    const [handles, delivered] = await Promise.all([store.handles([...new Set(winners)]), store.delivered(breaks.map((b) => b.id))]);
    return { now, ...(reserve ? { reserve } : {}), breaks, handles, delivered };
  }
}
