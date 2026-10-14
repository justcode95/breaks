import { describe, expect, it } from "vitest";
import { DEFAULT_RPC_URL, chainSetup } from "../lib/config";

const PROGRAM = "8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU";

describe("where the site reads the chain from", () => {
  it("is off until the program is named", () => {
    expect(chainSetup({})).toEqual({ kind: "off" });
    expect(chainSetup({ program: "  ", rpcUrl: "https://x.example" })).toEqual({ kind: "off" });
  });

  it("uses the public devnet node unless told otherwise", () => {
    expect(chainSetup({ program: PROGRAM })).toEqual({ kind: "on", config: { rpcUrl: DEFAULT_RPC_URL, breaksProgram: PROGRAM } });
    expect(chainSetup({ program: PROGRAM, rpcUrl: "" })).toMatchObject({ kind: "on", config: { rpcUrl: DEFAULT_RPC_URL } });
    expect(chainSetup({ program: ` ${PROGRAM} `, rpcUrl: "https://rpc.example/key" })).toEqual({ kind: "on", config: { rpcUrl: "https://rpc.example/key", breaksProgram: PROGRAM } });
  });

  it("accepts a plain http node only on this machine", () => {
    expect(chainSetup({ program: PROGRAM, rpcUrl: "http://localhost:8899" }).kind).toBe("on");
    expect(chainSetup({ program: PROGRAM, rpcUrl: "http://127.0.0.1:8899" }).kind).toBe("on");
    expect(chainSetup({ program: PROGRAM, rpcUrl: "http://rpc.example" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL must be an https:// address." });
    expect(chainSetup({ program: PROGRAM, rpcUrl: "ftp://rpc.example" }).kind).toBe("problem");
  });

  it("names what is wrong", () => {
    expect(chainSetup({ program: "nope" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_BREAKS_PROGRAM_ID is not a Solana address." });
    expect(chainSetup({ program: PROGRAM, rpcUrl: "not a url" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL is not a web address." });
  });
});
