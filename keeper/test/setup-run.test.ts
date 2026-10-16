import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { runSetup } from "../src/setup/run.js";
import { treasuryAuthorityAddress } from "../src/solana/breaks.js";
import { TOKEN_PROGRAM, programDataAddress } from "../src/solana/instruction.js";
import { associatedTokenAddress } from "../src/solana/pubkey.js";
import * as treasury from "../src/solana/treasury.js";
import { treasuryAddresses } from "../src/solana/treasury.js";
import { decodeTokenAccount } from "../src/solana/token.js";
import { encodeTokenAccount, encodeTreasuryConfig } from "./support/accounts.js";
import { addr } from "./support/chain.js";
import { mintData, programAccount } from "./support/doctor-world.js";
import { ADMIN_KEY, AUTHORITY, BUYER, KEEPER, SOL, USDC, decoded, setupWorld } from "./support/setup-world.js";
import { PROGRAMS } from "./support/world.js";

const CONTROLLER = treasuryAuthorityAddress(PROGRAMS);
const STEPS = ["treasury.initialize", "breaks.initialize", "treasury.set_controller", "ata.create"];
// What the four transactions cost the authority: the rent of what they make and 5,000 a signature.
const SPENT = 1_760_880n + 2n * 2_039_280n + 2_324_640n + 2_039_280n + 4n * 5_000n;

type World = ReturnType<typeof setupWorld>;
const run = async (w: World, over: Parameters<World["request"]>[0] = {}, keys: { admin?: typeof ADMIN_KEY } = {}) =>
  runSetup(w.request(over), { chain: await w.chain(), keys: { authority: AUTHORITY, ...keys } });
const marks = (out: string) => [...out.matchAll(/^ {2}(\[\w+\]) \d\. /gm)].map((m) => m[1]);

describe("setup-devnet: a dry run", () => {
  it("sends nothing, lists the four steps as todo, and exits 0", async () => {
    const w = setupWorld();
    const r = await run(w);
    expect(r.code).toBe(0);
    expect(w.node.sent).toHaveLength(0);
    expect(w.applied).toEqual([]);
    expect(marks(r.out)).toEqual(["[todo]", "[todo]", "[todo]", "[todo]"]);
    expect(r.out).toContain("Dry run: nothing is sent");
    expect(r.out).toContain("Dry run: nothing was sent. If this is what you want, run it again with --send.");
    expect(r.out).toContain("would send: admin " + AUTHORITY.address);
    expect(r.out).toContain("1. The treasury is initialized");
    expect(r.out).toContain("2. The breaks program is initialized (after step 1)");
    expect(r.out).toContain("3. The treasury's controller is the breaks program (after step 2)");
    expect(r.sent).toEqual([]);
  });

  it("reads only: the one request that is not a read is none", async () => {
    const w = setupWorld();
    await run(w);
    const methods = new Set(w.node.requests.map((r) => r.method));
    expect([...methods].sort()).toEqual(["getAccountInfo", "getGenesisHash"]);
  });

  it("asks for only the first bytes of a program-data account, not the program's code", async () => {
    const w = setupWorld();
    await run(w);
    const reads = w.node.requests.filter((r) => r.method === "getAccountInfo");
    const dataAccounts = [programDataAddress(PROGRAMS.breaks), programDataAddress(PROGRAMS.treasury)];
    for (const address of dataAccounts) {
      const read = reads.find((r) => r.params[0] === address);
      expect(read?.params[1], address).toMatchObject({ dataSlice: { offset: 0, length: 45 } });
    }
  });

  it("says who is who, without printing a key", async () => {
    const w = setupWorld();
    const r = await run(w);
    expect(r.out).toContain(`Authority (pays for everything): ${AUTHORITY.address}`);
    expect(r.out).toContain(`Admin: ${AUTHORITY.address} (this run holds its key)`);
    expect(r.out).toContain(`Keeper: ${KEEPER}`);
    expect(r.out).toContain(`Buyer wallet: ${BUYER}`);
    expect(r.out).toContain(`USDC mint: ${USDC}`);
  });
});

describe("setup-devnet --send", () => {
  it("does the four steps in order and leaves the chain as asked", async () => {
    const w = setupWorld();
    const r = await run(w, { send: true });
    expect(r.code).toBe(0);
    expect(w.applied).toEqual(STEPS);
    expect(w.node.sent).toHaveLength(4);
    expect(r.sent.map((s) => s.step)).toEqual(["treasury-initialize", "breaks-initialize", "treasury-controller", "buyer-usdc"]);
    expect(marks(r.out)).toEqual(["[sent]", "[sent]", "[sent]", "[sent]"]);
    for (const s of r.sent) expect(r.out).toContain(`transaction ${s.signature}`);
    expect(r.out).toContain("DONE. Everything is in place. Next: run `pnpm --filter keeper check-setup`.");

    expect(decoded.treasury(w)).toEqual({ admin: AUTHORITY.address, usdcMint: USDC, controller: CONTROLLER, subsidyBps: 7_000, holderBps: 3_000, lockedSubsidy: 0n, lockedHolder: 0n, bump: expect.any(Number) });
    expect(decoded.breaks(w)).toMatchObject({
      admin: AUTHORITY.address,
      keeper: KEEPER,
      buyer: BUYER,
      usdcMint: USDC,
      randomnessProgram: w.request().vrfProgram,
      randomnessTimeoutSecs: 600n,
      nextBreakId: 0n,
      minWindowSecs: 3_600n,
      maxWindowSecs: 21_600n,
      maxPaidSpots: 48,
      maxFreeSpots: 16,
      paused: false,
    });
    const t = treasuryAddresses(PROGRAMS.treasury);
    for (const vault of [t.subsidyVault, t.holderVault]) {
      expect(w.node.owners.get(vault)).toBe(TOKEN_PROGRAM);
      expect(decodeTokenAccount(w.node.accounts.get(vault) as Uint8Array)).toEqual({ mint: USDC, owner: t.config, amount: 0n });
    }
    const ata = associatedTokenAddress(BUYER, USDC);
    expect(w.node.owners.get(ata)).toBe(TOKEN_PROGRAM);
    expect(decodeTokenAccount(w.node.accounts.get(ata) as Uint8Array)).toEqual({ mint: USDC, owner: BUYER, amount: 0n });
  });

  it("costs the authority exactly what the plan said it needs, less what an account must keep", async () => {
    const w = setupWorld();
    await run(w, { send: true });
    expect(w.lamports(AUTHORITY.address)).toBe(5n * SOL - SPENT);
  });

  it("does nothing the second time", async () => {
    const w = setupWorld();
    await run(w, { send: true });
    const before = { sent: w.node.sent.length, applied: [...w.applied] };
    const again = await run(w, { send: true });
    expect(again.code).toBe(0);
    expect(w.node.sent).toHaveLength(before.sent);
    expect(w.applied).toEqual(before.applied);
    expect(marks(again.out)).toEqual(["[done]", "[done]", "[done]", "[done]"]);
    expect(again.out).toContain("Nothing to do: everything is already in place.");
  });

  it("takes the whole path through the real RPC client: every transaction is signed, verified and executed", async () => {
    const w = setupWorld();
    await run(w, { send: true });
    // The model verifies each signature with web3.js before running anything, so a wrong signer would have refused the first one.
    expect(w.node.requests.filter((r) => r.method === "sendTransaction")).toHaveLength(4);
  });

  it("carries on from where an interrupted run stopped, sending only what is missing", async () => {
    const w = setupWorld();
    w.refuse.add("breaks.initialize");
    const first = await run(w, { send: true });
    expect(first.code).toBe(1);
    expect(w.applied).toEqual(["treasury.initialize"]);
    expect(marks(first.out)).toEqual(["[sent]", "[FAIL]", "[todo]", "[todo]"]);
    expect(first.out).toContain("the chain refused it, nothing changed: Injected");
    expect(first.out).toContain("NOT DONE. A step did not land: see above.");
    // Nothing after the failed step was tried.
    expect(w.node.sent).toHaveLength(0 + 1);

    w.refuse.clear();
    const second = await run(w, { send: true });
    expect(second.code).toBe(0);
    expect(w.applied).toEqual(STEPS);
    expect(marks(second.out)).toEqual(["[done]", "[sent]", "[sent]", "[sent]"]);
  });

  it("says when it cannot tell whether a step landed, and stops there", async () => {
    const w = setupWorld();
    w.node.sendScript.push(...Array.from({ length: 200 }, () => "http-503" as const));
    const r = await run(w, { send: true });
    expect(r.code).toBe(1);
    expect(w.applied).toEqual([]);
    expect(marks(r.out)).toEqual(["[stop]", "[todo]", "[todo]", "[todo]"]);
    expect(r.out).toContain("the result is not known: look at the chain before running this again");
  });

  it("asks the node, before each step, what is on chain, so a step done by somebody else is not repeated", async () => {
    const w = setupWorld();
    const chain = await w.chain();
    // Somebody sends the treasury's initialize between this run's first read and its first send.
    const real = chain.sendAndConfirm.bind(chain);
    let raced = false;
    chain.sendAndConfirm = async (ix, opts) => {
      if (!raced) {
        raced = true;
        await real(ix, opts); // theirs, the same instruction
      }
      return real(ix, opts);
    };
    const r = await runSetup(w.request({ send: true }), { chain, keys: { authority: AUTHORITY } });
    // Ours was refused by the program (the account exists): the run reports it instead of pretending.
    expect(r.code).toBe(1);
    expect(r.out).toContain("the chain refused it, nothing changed: AccountAlreadyInUse");
    expect(w.applied).toEqual(["treasury.initialize"]);
    // And the next run reads it, and finishes the rest.
    const next = await run(w, { send: true });
    expect(next.code).toBe(0);
    expect(w.applied).toEqual(STEPS);
  });
});

describe("setup-devnet: what stops it", () => {
  const expectNothingSent = (w: World) => {
    expect(w.node.sent).toHaveLength(0);
    expect(w.applied).toEqual([]);
  };

  it("does not send with a key that is not the upgrade authority, and names who is", async () => {
    const other = addr(0xee);
    const w = setupWorld({ upgradeAuthority: other });
    const r = await run(w, { send: true });
    expect(r.code).toBe(1);
    expectNothingSent(w);
    expect(marks(r.out).slice(0, 3)).toEqual(["[stop]", "[stop]", "[stop]"]);
    expect(r.out).toContain(`the treasury program's upgrade authority is ${other}, not ${AUTHORITY.address}`);
    expect(r.out).toContain("NOT DONE. Something stands in the way: see above.");
  });

  it("sends nothing at all while anything is blocked, even a step that could be done", async () => {
    const w = setupWorld({ upgradeAuthority: addr(0xee) });
    await run(w, { send: true });
    // The buyer's USDC account could have been made; it was not.
    expect(w.node.accounts.has(associatedTokenAddress(BUYER, USDC))).toBe(false);
  });

  it("does not send for a program that can no longer be upgraded, or that is not deployed", async () => {
    const frozen = setupWorld({ upgradeAuthority: null });
    expect((await run(frozen, { send: true })).out).toContain("can no longer be upgraded, so nobody can initialize it");
    expectNothingSent(frozen);

    const missing = setupWorld();
    missing.node.accounts.delete(PROGRAMS.treasury);
    const r = await run(missing, { send: true });
    expect(r.out).toContain("the treasury program does not exist on this network: is it deployed, and is the program id right?");
    expect(r.code).toBe(1);
    expectNothingSent(missing);

    const notAProgram = setupWorld();
    notAProgram.node.executables.delete(PROGRAMS.breaks);
    expect((await run(notAProgram)).out).toContain("the breaks program is not an upgradeable program");

    // Executable, but not a program of the upgradeable loader.
    const otherLoader = setupWorld();
    otherLoader.node.owners.set(PROGRAMS.treasury, addr(0x55));
    const o = await run(otherLoader, { send: true });
    expect(o.out).toContain("the treasury program is not an upgradeable program");
    expect(o.code).toBe(1);
    expectNothingSent(otherLoader);

    // A program account that points at somebody else's program-data account.
    const pointsAway = setupWorld();
    pointsAway.node.accounts.set(PROGRAMS.breaks, programAccount(addr(0x77)));
    const p = await run(pointsAway, { send: true });
    expect(p.out).toContain("the breaks program points at a program-data account that is not its own");
    expectNothingSent(pointsAway);

    // A program account or a program-data account that is not what the loader writes.
    const garbage = setupWorld();
    garbage.node.accounts.set(PROGRAMS.treasury, new Uint8Array(36));
    expect((await run(garbage)).out).toContain("the treasury program could not be read");
    const noData = setupWorld();
    noData.node.accounts.delete(programDataAddress(PROGRAMS.treasury));
    expect((await run(noData)).out).toContain("the treasury program has no program-data account");
    const badData = setupWorld();
    badData.node.accounts.set(programDataAddress(PROGRAMS.treasury), new Uint8Array(45));
    expect((await run(badData)).out).toContain("the treasury program could not be read");
  });

  it("does not send with a USDC mint that is missing, has other decimals, belongs to another program or is not initialized", async () => {
    const cases: [string, (w: World) => void, string][] = [
      ["missing", (w) => w.node.accounts.delete(USDC), `${USDC} does not exist on this network`],
      ["9 decimals", (w) => w.node.accounts.set(USDC, mintData(1n, 9)), "has 9 decimals; USDC has 6"],
      ["other owner", (w) => w.node.owners.set(USDC, addr(0x55)), `is not a mint of the classic token program (it is owned by ${addr(0x55)})`],
      ["uninitialized", (w) => w.node.accounts.set(USDC, new Uint8Array(82)), "is not an initialized mint"],
      ["too short", (w) => w.node.accounts.set(USDC, new Uint8Array(10)), "could not be read"],
    ];
    for (const [name, spoil, text] of cases) {
      const w = setupWorld();
      spoil(w);
      const r = await run(w, { send: true });
      expect(r.code, name).toBe(1);
      expect(r.out, name).toContain(text);
      expectNothingSent(w);
    }
  });

  it("does not send when the authority cannot pay, down to one lamport, and says what it needs", async () => {
    const needed = 11_114_240n;
    const short = setupWorld({ authorityLamports: needed - 1n });
    const r = await run(short, { send: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Problem: the upgrade authority ${AUTHORITY.address} holds ${needed - 1n} lamports and this needs ${needed}`);
    expectNothingSent(short);

    // With exactly that much it works, and is left with exactly what an account must keep.
    const exact = setupWorld({ authorityLamports: needed });
    const ok = await run(exact, { send: true });
    expect(ok.code).toBe(0);
    expect(exact.lamports(AUTHORITY.address)).toBe(890_880n);
  });

  it("refuses roles that give a hot wallet authority", async () => {
    const w = setupWorld();
    const r = await run(w, { send: true, keeper: AUTHORITY.address });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Problem: the keeper's address is the upgrade authority");
    expectNothingSent(w);
  });

  it("refuses an --admin that is not the --admin-keypair's address", async () => {
    const w = setupWorld();
    const r = await run(w, { send: true, admin: addr(0xad) }, { admin: ADMIN_KEY });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Problem: --admin is ${addr(0xad)} but --admin-keypair is the key of ${ADMIN_KEY.address}`);
    expectNothingSent(w);
  });
});

describe("setup-devnet: an admin that is not the upgrade authority", () => {
  it("does everything it can, then prints exactly what the admin has to send, and exits 3", async () => {
    const w = setupWorld();
    const r = await run(w, { send: true, admin: ADMIN_KEY.address });
    expect(r.code).toBe(3);
    expect(w.applied).toEqual(["treasury.initialize", "breaks.initialize", "ata.create"]);
    expect(decoded.treasury(w)).toMatchObject({ admin: ADMIN_KEY.address, controller: "11111111111111111111111111111111" });
    expect(marks(r.out)).toEqual(["[sent]", "[sent]", "[wait]", "[sent]"]);
    expect(r.out).toContain(`only the admin ${ADMIN_KEY.address} can send this, and this run does not hold its key`);
    expect(r.out).toContain("WAITING FOR THE ADMIN.");

    const ix = treasury.setController(PROGRAMS.treasury, { admin: ADMIN_KEY.address, controller: CONTROLLER });
    expect(r.out).toContain(`program ${PROGRAMS.treasury}`);
    expect(r.out).toContain(`account 1: ${ADMIN_KEY.address} (signer)`);
    expect(r.out).toContain(`account 2: ${treasuryAddresses(PROGRAMS.treasury).config} (writable)`);
    expect(r.out).toContain(`data (base64): ${base64.encode(ix.data)}`);
    expect(r.out).toContain(`data (hex): ${[...ix.data].map((n) => n.toString(16).padStart(2, "0")).join("")}`);
  });

  it("sends set_controller itself when it is given the admin's key, with both signatures and the authority paying", async () => {
    const w = setupWorld();
    await run(w, { send: true, admin: ADMIN_KEY.address });
    const before = w.lamports(AUTHORITY.address);
    const r = await run(w, { send: true, admin: ADMIN_KEY.address }, { admin: ADMIN_KEY });
    expect(r.code).toBe(0);
    expect(w.applied.at(-1)).toBe("treasury.set_controller");
    expect(decoded.treasury(w).controller).toBe(CONTROLLER);
    // Two signatures, 5,000 lamports each, paid by the authority; the admin needed no SOL of its own.
    expect(before - w.lamports(AUTHORITY.address)).toBe(10_000n);
    expect(w.lamports(ADMIN_KEY.address)).toBe(0n);
  });

  it("does the whole setup in one run when it has both keys", async () => {
    const w = setupWorld();
    const r = await run(w, { send: true }, { admin: ADMIN_KEY });
    expect(r.code).toBe(0);
    expect(w.applied).toEqual(STEPS);
    expect(decoded.treasury(w).admin).toBe(ADMIN_KEY.address);
    expect(decoded.breaks(w).admin).toBe(ADMIN_KEY.address);
  });

  it("is not done while the admin has not sent it, and says so on a dry run too", async () => {
    const w = setupWorld();
    await run(w, { send: true, admin: ADMIN_KEY.address });
    const dry = await run(w, { admin: ADMIN_KEY.address });
    expect(dry.code).toBe(3);
  });
});

describe("setup-devnet: what is already on chain", () => {
  it("shows every difference and changes nothing, even with --send", async () => {
    const w = setupWorld();
    await run(w, { send: true, subsidyBps: 5_000, holderBps: 5_000, keeper: addr(0x4c) });
    const applied = [...w.applied];
    const r = await run(w, { send: true });
    expect(r.code).toBe(1);
    expect(w.applied).toEqual(applied);
    expect(marks(r.out)).toEqual(["[diff]", "[diff]", "[done]", "[done]"]);
    expect(r.out).toContain("split: on chain 50% subsidy / 50% holder, asked for 70% / 30% (the admin can change it with set_split)");
    expect(r.out).toContain(`keeper: on chain ${addr(0x4c)}, asked for ${KEEPER} (the admin can change it with set_keeper)`);
    expect(r.out).toContain("it is on chain, but not as asked (nothing was changed):");
  });

  it("sends nothing while one value differs, even a step that is missing and could be sent", async () => {
    const w = setupWorld();
    // A first run that stops after the second step: the controller and the buyer's account are still to do.
    w.refuse.add("treasury.set_controller");
    await run(w, { send: true });
    w.refuse.clear();
    expect(w.applied).toEqual(["treasury.initialize", "breaks.initialize"]);
    // Asked for another split, the treasury differs: the missing steps are listed, but none is sent.
    const r = await run(w, { send: true, subsidyBps: 5_000, holderBps: 5_000 });
    expect(r.code).toBe(1);
    expect(marks(r.out)).toEqual(["[diff]", "[done]", "[todo]", "[todo]"]);
    expect(w.applied).toEqual(["treasury.initialize", "breaks.initialize"]);
    expect(w.node.accounts.has(associatedTokenAddress(BUYER, USDC))).toBe(false);
  });

  it("does not replace a controller that is set to another address", async () => {
    const w = setupWorld();
    await run(w, { send: true });
    const config = decoded.treasury(w);
    const other = addr(0x99);
    w.node.accounts.set(treasuryAddresses(PROGRAMS.treasury).config, encodeTreasuryConfig({ ...config, controller: other }));
    const r = await run(w, { send: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`controller: on chain ${other}`);
    expect(decoded.treasury(w).controller).toBe(other);
    expect(w.applied).toEqual(STEPS);
  });

  it("makes the buyer's USDC account when somebody has only sent it SOL", async () => {
    const w = setupWorld();
    w.node.accounts.set(associatedTokenAddress(BUYER, USDC), new Uint8Array(0));
    w.node.lamports.set(associatedTokenAddress(BUYER, USDC), 1_000n);
    const r = await run(w, { send: true });
    expect(r.code).toBe(0);
    expect(w.applied).toContain("ata.create");
    expect(w.node.owners.get(associatedTokenAddress(BUYER, USDC))).toBe(TOKEN_PROGRAM);
  });

  it("leaves an existing USDC account of the buyer alone, with its balance", async () => {
    const w = setupWorld();
    const ata = associatedTokenAddress(BUYER, USDC);
    w.node.accounts.set(ata, encodeTokenAccount({ mint: USDC, owner: BUYER, amount: 123n }));
    w.node.owners.set(ata, TOKEN_PROGRAM);
    const r = await run(w, { send: true });
    expect(r.code).toBe(0);
    expect(w.applied).toEqual(["treasury.initialize", "breaks.initialize", "treasury.set_controller"]);
    expect(decodeTokenAccount(w.node.accounts.get(ata) as Uint8Array).amount).toBe(123n);
  });

  it("stops at an account at the buyer's address that is not a token account of the buyer", async () => {
    const ata = associatedTokenAddress(BUYER, USDC);
    const wrongProgram = setupWorld();
    wrongProgram.node.accounts.set(ata, new Uint8Array(165));
    wrongProgram.node.owners.set(ata, addr(0x55));
    const a = await run(wrongProgram, { send: true });
    expect(a.out).toContain(`is owned by ${addr(0x55)}, not by the token program`);
    expect(a.code).toBe(1);
    expect(wrongProgram.applied).toEqual([]);

    const wrongMint = setupWorld();
    wrongMint.node.accounts.set(ata, encodeTokenAccount({ mint: addr(0x67), owner: BUYER, amount: 0n }));
    wrongMint.node.owners.set(ata, TOKEN_PROGRAM);
    expect((await run(wrongMint, { send: true })).out).toContain("belongs to another mint or owner than its address says");
    expect(wrongMint.applied).toEqual([]);

    const tooShort = setupWorld();
    tooShort.node.accounts.set(ata, new Uint8Array(10));
    tooShort.node.owners.set(ata, TOKEN_PROGRAM);
    expect((await run(tooShort)).out).toContain("could not be read");

    const wrongOwner = setupWorld();
    wrongOwner.node.accounts.set(ata, encodeTokenAccount({ mint: USDC, owner: addr(0x66), amount: 0n }));
    wrongOwner.node.owners.set(ata, TOKEN_PROGRAM);
    const b = await run(wrongOwner, { send: true });
    expect(b.out).toContain("belongs to another mint or owner than its address says");
    expect(wrongOwner.applied).toEqual([]);
  });

  it("stops at a configuration account that another program owns", async () => {
    const w = setupWorld();
    w.node.accounts.set(treasuryAddresses(PROGRAMS.treasury).config, new Uint8Array(125));
    w.node.owners.set(treasuryAddresses(PROGRAMS.treasury).config, addr(0x55));
    const r = await run(w, { send: true });
    expect(r.out).toContain(`is owned by ${addr(0x55)}, not by the program that should own it`);
    expect(r.code).toBe(1);
    expect(w.applied).toEqual([]);
  });
});
