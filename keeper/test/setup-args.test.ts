import { describe, expect, it } from "vitest";
import { USAGE, parseArgs } from "../src/setup/args.js";
import { ORAO_PROGRAM } from "../src/solana/breaks.js";
import { addr } from "./support/chain.js";
import { PROGRAMS } from "./support/world.js";

const ENV = {
  SOLANA_RPC_URL: "https://rpc.example/SECRET",
  BREAKS_PROGRAM_ID: PROGRAMS.breaks,
  TREASURY_PROGRAM_ID: PROGRAMS.treasury,
};
const KEEPER = addr(0x4b);
const BUYER = addr(0xb0);
const MINT = addr(0xc0);
const REQUIRED = ["--authority-keypair", "/keys/authority.json", "--keeper", KEEPER, "--buyer", BUYER, "--usdc-mint", MINT, "--max-paid-spots", "48", "--max-free-spots", "16"];

const problems = (argv: string[], env: Record<string, string | undefined> = ENV): string[] => {
  const r = parseArgs(argv, env);
  if (r.kind !== "error") throw new Error(`expected problems, got ${r.kind}`);
  return r.problems;
};
const ok = (argv: string[], env: Record<string, string | undefined> = ENV) => {
  const r = parseArgs(argv, env);
  if (r.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.request;
};

describe("setup-devnet: the command line", () => {
  it("shows the usage for --help or -h, wherever it is", () => {
    expect(parseArgs(["--help"], {})).toEqual({ kind: "help" });
    expect(parseArgs(["-h"], {})).toEqual({ kind: "help" });
    expect(parseArgs([...REQUIRED, "--help"], ENV)).toEqual({ kind: "help" });
    expect(USAGE).toContain("It only PRINTS what it would do unless --send is given");
    expect(USAGE).toContain("Devnet only");
  });

  it("reads the required flags, takes the decided defaults and is a dry run unless told to send", () => {
    expect(ok(REQUIRED)).toEqual({
      programs: PROGRAMS,
      vrfProgram: ORAO_PROGRAM,
      rpcUrl: "https://rpc.example/SECRET",
      cluster: "devnet",
      usdcMint: MINT,
      keeper: KEEPER,
      buyer: BUYER,
      admin: undefined,
      subsidyBps: 7_000,
      holderBps: 3_000,
      minWindowSecs: 3_600n,
      maxWindowSecs: 21_600n,
      maxPaidSpots: 48,
      maxFreeSpots: 16,
      randomnessTimeoutSecs: 600n,
      authorityKeypair: "/keys/authority.json",
      adminKeypair: undefined,
      send: false,
    });
  });

  it("reads every optional flag, in both the `--flag value` and the `--flag=value` forms, and --send", () => {
    const admin = addr(0xad);
    const r = ok([
      ...REQUIRED,
      `--admin=${admin}`,
      "--admin-keypair",
      "/keys/admin.json",
      "--subsidy-bps=5000",
      "--holder-bps",
      "5000",
      "--min-window-secs",
      "1800",
      "--max-window-secs=7200",
      "--randomness-timeout-secs",
      "900",
      "--send",
    ]);
    expect(r).toMatchObject({ admin, adminKeypair: "/keys/admin.json", subsidyBps: 5_000, holderBps: 5_000, minWindowSecs: 1_800n, maxWindowSecs: 7_200n, randomnessTimeoutSecs: 900n, send: true });
  });

  it("ignores the `--` that pnpm puts in front of the flags", () => {
    expect(ok(["--", ...REQUIRED]).maxPaidSpots).toBe(48);
  });

  it("takes the VRF program from the environment, ORAO by default, and the cluster, devnet by default", () => {
    expect(ok(REQUIRED, { ...ENV, VRF_PROGRAM_ID: addr(0x77) }).vrfProgram).toBe(addr(0x77));
    expect(ok(REQUIRED, { ...ENV, VRF_PROGRAM_ID: "  " }).vrfProgram).toBe(ORAO_PROGRAM);
    expect(ok(REQUIRED, { ...ENV, SOLANA_CLUSTER: "localnet" }).cluster).toBe("localnet");
  });

  it("names every missing required flag at once", () => {
    expect(problems([])).toEqual([
      "--authority-keypair is required",
      "--keeper is required",
      "--buyer is required",
      "--usdc-mint is required",
      "--max-paid-spots is required",
      "--max-free-spots is required",
    ]);
  });

  it("refuses a value that is not an address, naming the flag", () => {
    for (const flag of ["--keeper", "--buyer", "--usdc-mint", "--admin"]) {
      const argv = flag === "--admin" ? [...REQUIRED, flag, "nope"] : REQUIRED.map((a, i) => (REQUIRED[i - 1] === flag ? "nope" : a));
      expect(problems(argv), flag).toEqual([`${flag} is not a Solana address`]);
    }
    // 31 bytes of base58 is not an address either.
    expect(problems(REQUIRED.map((a, i) => (REQUIRED[i - 1] === "--keeper" ? "1111111111111111111111111111111" : a)))).toEqual(["--keeper is not a Solana address"]);
  });

  it("refuses the limits the program refuses, at their edges", () => {
    const free = (n: string) => REQUIRED.map((a, i) => (REQUIRED[i - 1] === "--max-free-spots" ? n : a));
    const paid = (n: string) => REQUIRED.map((a, i) => (REQUIRED[i - 1] === "--max-paid-spots" ? n : a));
    expect(ok(free("16")).maxFreeSpots).toBe(16);
    expect(problems(free("17"))).toEqual(["--max-free-spots must be from 0 to 16"]);
    expect(ok(free("0")).maxFreeSpots).toBe(0);
    expect(problems(paid("0"))).toEqual(["--max-paid-spots must be from 1 to 65535"]);
    // 64 packs at most, one per spot.
    expect(ok(REQUIRED).maxPaidSpots + ok(REQUIRED).maxFreeSpots).toBe(64);
    expect(problems(paid("49"))).toEqual(["--max-paid-spots + --max-free-spots is 65; a break has at most 64 spots (one pack each)"]);
  });

  it("refuses numbers that are not whole numbers", () => {
    for (const bad of ["1.5", "-1", "1e3", "ten", "0x10", " "]) {
      const argv = REQUIRED.map((a, i) => (REQUIRED[i - 1] === "--max-paid-spots" ? bad : a));
      expect(problems(argv).length, bad).toBeGreaterThan(0);
    }
    expect(problems([...REQUIRED, "--subsidy-bps", "7000.5"])).toEqual(["--subsidy-bps is not a whole number"]);
  });

  it("requires the split to add up to 10000, as the treasury does, and the windows to be in order", () => {
    expect(problems([...REQUIRED, "--subsidy-bps", "7000", "--holder-bps", "2999"])).toEqual(["--subsidy-bps + --holder-bps is 9999; the two must add up to 10000"]);
    expect(problems([...REQUIRED, "--subsidy-bps", "7000", "--holder-bps", "3001"])).toEqual(["--subsidy-bps + --holder-bps is 10001; the two must add up to 10000"]);
    expect(ok([...REQUIRED, "--subsidy-bps", "0", "--holder-bps", "10000"]).holderBps).toBe(10_000);
    expect(ok([...REQUIRED, "--subsidy-bps", "10000", "--holder-bps", "0"]).subsidyBps).toBe(10_000);
    expect(problems([...REQUIRED, "--min-window-secs", "7200", "--max-window-secs", "3600"])).toEqual(["--min-window-secs must not be above --max-window-secs"]);
    expect(ok([...REQUIRED, "--min-window-secs", "3600", "--max-window-secs", "3600"]).minWindowSecs).toBe(3_600n);
    expect(problems([...REQUIRED, "--min-window-secs", "0"])).toEqual(["--min-window-secs must be from 1 to 2147483648"]);
    expect(problems([...REQUIRED, "--randomness-timeout-secs", "0"])).toEqual(["--randomness-timeout-secs must be from 1 to 2147483648"]);
  });

  it("refuses unknown flags, flags without a value and a flag given twice", () => {
    expect(problems([...REQUIRED, "--sned"])).toEqual(["unknown argument --sned"]);
    expect(problems([...REQUIRED, "positional"])).toEqual(["unknown argument positional"]);
    expect(problems([...REQUIRED, "--admin"])).toEqual(["--admin needs a value"]);
    expect(problems([...REQUIRED, "--admin", "--send"])).toEqual(["--admin needs a value"]);
    expect(problems([...REQUIRED, "--keeper", addr(9)])).toEqual(["--keeper is given twice"]);
  });

  it("names a missing or unusable setting from the environment, and refuses any cluster but devnet or a local one", () => {
    expect(problems(REQUIRED, {})).toEqual(["BREAKS_PROGRAM_ID is not set", "TREASURY_PROGRAM_ID is not set", "SOLANA_RPC_URL is not set"]);
    expect(problems(REQUIRED, { ...ENV, BREAKS_PROGRAM_ID: "x" })).toEqual(["BREAKS_PROGRAM_ID is not a Solana address"]);
    expect(problems(REQUIRED, { ...ENV, VRF_PROGRAM_ID: "x" })).toEqual(["VRF_PROGRAM_ID is not a Solana address"]);
    expect(problems(REQUIRED, { ...ENV, SOLANA_CLUSTER: "mainnet-beta" })).toEqual(["SOLANA_CLUSTER is mainnet-beta: this tool runs on devnet only"]);
  });

  it("reports every problem at once", () => {
    const all = problems(["--keeper", "x", "--max-free-spots", "99", "--sned"], { ...ENV, SOLANA_CLUSTER: "testnet" });
    expect(all).toEqual(
      expect.arrayContaining([
        "unknown argument --sned",
        "--authority-keypair is required",
        "--keeper is not a Solana address",
        "--buyer is required",
        "--usdc-mint is required",
        "--max-paid-spots is required",
        "--max-free-spots must be from 0 to 16",
        "SOLANA_CLUSTER is testnet: this tool runs on devnet only",
      ]),
    );
  });
});
