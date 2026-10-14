import { describe, expect, it } from "vitest";
import { DEFAULT_RPC_URL, chainSetup, publishedSetup, treasurySetup } from "../lib/config";

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

describe("where the treasury page reads from", () => {
  it("is off until the treasury program is named, and takes the same node as the rest of the site", () => {
    expect(treasurySetup({})).toEqual({ kind: "off" });
    expect(treasurySetup({ program: "", rpcUrl: "https://x.example" })).toEqual({ kind: "off" });
    expect(treasurySetup({ program: PROGRAM })).toEqual({ kind: "on", config: { rpcUrl: DEFAULT_RPC_URL, treasuryProgram: PROGRAM } });
    expect(treasurySetup({ program: PROGRAM, rpcUrl: "https://rpc.example/key" })).toEqual({ kind: "on", config: { rpcUrl: "https://rpc.example/key", treasuryProgram: PROGRAM } });
  });

  it("names the setting that is wrong", () => {
    expect(treasurySetup({ program: "nope" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_TREASURY_PROGRAM_ID is not a Solana address." });
    expect(treasurySetup({ program: PROGRAM, rpcUrl: "http://rpc.example" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL must be an https:// address." });
    expect(treasurySetup({ program: PROGRAM, rpcUrl: "nope" })).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_SOLANA_RPC_URL is not a web address." });
    expect(treasurySetup({ program: PROGRAM, rpcUrl: "http://localhost:8899" }).kind).toBe("on");
  });
});

describe("where the published lists are read from", () => {
  it("is off until a folder is named", () => {
    expect(publishedSetup(undefined)).toEqual({ kind: "off" });
    expect(publishedSetup("")).toEqual({ kind: "off" });
    expect(publishedSetup("   ")).toEqual({ kind: "off" });
  });

  it("takes an https folder, with or without a trailing slash, and keeps its path", () => {
    expect(publishedSetup("https://files.example")).toEqual({ kind: "on", config: { baseUrl: "https://files.example" } });
    expect(publishedSetup("https://files.example/")).toEqual({ kind: "on", config: { baseUrl: "https://files.example" } });
    expect(publishedSetup(" https://files.example/breaks/published/// ")).toEqual({ kind: "on", config: { baseUrl: "https://files.example/breaks/published" } });
    expect(publishedSetup("https://files.example:8443/p")).toEqual({ kind: "on", config: { baseUrl: "https://files.example:8443/p" } });
  });

  it("accepts a plain http folder only on this machine", () => {
    expect(publishedSetup("http://localhost:8080/published")).toEqual({ kind: "on", config: { baseUrl: "http://localhost:8080/published" } });
    expect(publishedSetup("http://127.0.0.1:8080")).toEqual({ kind: "on", config: { baseUrl: "http://127.0.0.1:8080" } });
    expect(publishedSetup("http://files.example")).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL must be an https:// address." });
    expect(publishedSetup("ftp://files.example").kind).toBe("problem");
  });

  it("names what is wrong, and refuses an address that carries a login, a query or a fragment", () => {
    expect(publishedSetup("not a url")).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL is not a web address." });
    for (const bad of ["https://user:pass@files.example", "https://user@files.example", "https://files.example/p?key=1", "https://files.example/p#x"]) {
      expect(publishedSetup(bad), bad).toEqual({ kind: "problem", problem: "NEXT_PUBLIC_PUBLISHED_URL must be a plain folder address, without a login, a query or a fragment." });
    }
  });
});
