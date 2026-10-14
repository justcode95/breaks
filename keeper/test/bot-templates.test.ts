import { describe, expect, it } from "vitest";
import {
  MAX_POST_LENGTH,
  breakNumber,
  isHandle,
  machineText,
  openPost,
  plainText,
  plural,
  reminderPost,
  reservePost,
  resultsPost,
  shortWallet,
  timeLeft,
  tweetLength,
  usd,
  utc,
  winnersPost,
} from "../src/bot/templates.js";

describe("numbers and times", () => {
  it("shows an on-chain id as the break people count: the first is #1", () => {
    expect(breakNumber(0n)).toBe("1");
    expect(breakNumber(41n)).toBe("42");
  });

  it("shows dollars, rounding up to the cent so nothing looks cheaper than it is", () => {
    expect(usd(20_000_000n)).toBe("$20");
    expect(usd(20_500_000n)).toBe("$20.50");
    expect(usd(1_250_000_000n)).toBe("$1,250");
    expect(usd(1_234_567_890n)).toBe("$1,234.57");
    expect(usd(10_001n)).toBe("$0.02");
    expect(usd(0n)).toBe("$0");
    expect(usd(10_000n)).toBe("$0.01");
  });

  it("shows a time in UTC", () => {
    expect(utc(1_800_000_000n)).toBe("Jan 15, 08:00 UTC");
    expect(utc(1_800_021_600n)).toBe("Jan 15, 14:00 UTC");
    expect(utc(1_767_225_540n)).toBe("Dec 31, 23:59 UTC");
  });

  it("says how long is left in hours, or minutes under an hour and a half", () => {
    expect(timeLeft(3 * 3600)).toBe("3h");
    expect(timeLeft(2.6 * 3600)).toBe("3h");
    expect(timeLeft(5_400)).toBe("2h");
    expect(timeLeft(5_399)).toBe("90 min");
    expect(timeLeft(3_600)).toBe("60 min");
    expect(timeLeft(45 * 60)).toBe("45 min");
    expect(timeLeft(10)).toBe("1 min");
  });

  it("shortens a wallet, and counts plurals", () => {
    expect(shortWallet("4F7BsTMVPKFshM1MwLf6y23cid6fL3xMpazVoF9krzUw")).toBe("4F7B…rzUw");
    expect(shortWallet("short")).toBe("short");
    expect(plural(1, "spot", "spots")).toBe("spot");
    expect(plural(0, "spot", "spots")).toBe("spots");
    expect(plural(2, "spot", "spots")).toBe("spots");
  });
});

describe("text that comes from outside", () => {
  it("accepts only plain X handles", () => {
    for (const ok of ["a", "Satoshi_1", "x".repeat(15)]) expect(isHandle(ok), ok).toBe(true);
    for (const bad of ["", "x".repeat(16), "has space", "a-b", "@name", "name\n", "evil http://x.co", "ünï", "a.b"]) expect(isHandle(bad), JSON.stringify(bad)).toBe(false);
  });

  it("strips links, mentions and line breaks and cuts to length", () => {
    expect(plainText("PSA 10 Charizard @elonmusk see https://evil.example/x now")).toBe("PSA 10 Charizard elonmusk see now");
    expect(plainText("line one\nline two\t\tend")).toBe("line one line two end");
    expect(plainText("a".repeat(100))).toHaveLength(60);
    expect(plainText("😀".repeat(100), 5)).toBe("😀😀😀😀😀");
    expect(plainText("   ")).toBe("");
  });

  it("shortens a raw machine id and cleans a machine label", () => {
    expect(machineText("pokemon-25")).toBe("pokemon-25");
    expect(machineText(`0x${"ab".repeat(32)}`)).toBe("0xabab…abab");
    expect(machineText("Pokemon @everyone http://x.co")).toBe("Pokemon everyone");
  });
});

describe("how X counts a post", () => {
  it("counts ordinary text once and emoji, arrows and the ellipsis twice", () => {
    expect(tweetLength("hello")).toBe(5);
    expect(tweetLength("—")).toBe(1); // an em dash is light
    expect(tweetLength("🔥")).toBe(2);
    expect(tweetLength("→")).toBe(2);
    expect(tweetLength("…")).toBe(2);
    expect(tweetLength("é")).toBe(1);
  });

  it("counts a link as 23 whatever its length", () => {
    expect(tweetLength("see https://example.org/a/very/long/path/that/goes/on/and/on?x=1")).toBe(4 + 23);
    expect(tweetLength("http://a.co")).toBe(23);
  });
});

describe("the five posts", () => {
  it("announces the reserve", () => {
    expect(reservePost({ breakId: 0n, percent: 50, target: 100_000_000n })).toBe("Break #1 is 50% funded 🔥 Unlocks at $100.");
  });

  it("announces a live sale, with and without free spots, and with one spot", () => {
    const a = { breakId: 6n, paid: 10, free: 2, price: 20_000_000n, machine: "pokemon-25", closesAt: 1_800_021_600n };
    expect(openPost(a)).toBe("Break #7 is LIVE — 10 paid spots @ $20 + 2 FREE holder spots. Packs: pokemon-25. Closes Jan 15, 14:00 UTC.");
    expect(openPost({ ...a, free: 1, paid: 1 })).toBe("Break #7 is LIVE — 1 paid spot @ $20 + 1 FREE holder spot. Packs: pokemon-25. Closes Jan 15, 14:00 UTC.");
    expect(openPost({ ...a, free: 0 })).toBe("Break #7 is LIVE — 10 paid spots @ $20. Packs: pokemon-25. Closes Jan 15, 14:00 UTC.");
  });

  it("reminds how many spots are left", () => {
    expect(reminderPost({ breakId: 0n, left: 4, secsLeft: 3 * 3600 })).toBe("4 spots left in Break #1. Closes in 3h.");
    expect(reminderPost({ breakId: 0n, left: 1, secsLeft: 20 * 60 })).toBe("1 spot left in Break #1. Closes in 20 min.");
  });

  it("names the free-spot winners", () => {
    expect(winnersPost({ breakId: 2n, names: ["@alice", "4F7B…rzUw"] })).toBe("Free holder spots in Break #3 go to @alice, 4F7B…rzUw 🎉");
  });

  it("fits any number of winners in a post, dropping the last ones for 'and N more'", () => {
    const names = Array.from({ length: 16 }, (_, i) => `@handle_number_${i}`.slice(0, 16));
    const post = winnersPost({ breakId: 0n, names });
    expect(tweetLength(post)).toBeLessThanOrEqual(MAX_POST_LENGTH);
    expect(post).toMatch(/ and \d+ more 🎉$/);
    // Few names are all shown.
    expect(winnersPost({ breakId: 0n, names: names.slice(0, 3) })).not.toMatch(/more/);
    // At least one name is always shown.
    expect(winnersPost({ breakId: 0n, names: ["@x"] })).toBe("Free holder spots in Break #1 go to @x 🎉");
  });

  it("posts the results with the card counts, or the best card when it is known, and the link when there is one", () => {
    const a = { breakId: 0n, cards: 12, wallets: 11 };
    expect(resultsPost(a)).toBe("Break #1 results are in: 12 cards sent to 11 wallets.");
    expect(resultsPost({ ...a, cards: 1, wallets: 1 })).toBe("Break #1 results are in: 1 card sent to 1 wallet.");
    expect(resultsPost({ ...a, link: "https://example.org/breaks/1" })).toBe("Break #1 results are in: 12 cards sent to 11 wallets. Full results + proof: https://example.org/breaks/1");
    expect(resultsPost({ ...a, topHit: { name: "PSA 10 Charizard", winner: "@alice" }, link: "https://example.org/breaks/1" })).toBe(
      "Break #1 results: PSA 10 Charizard → @alice. Full results + proof: https://example.org/breaks/1",
    );
  });

  it("cannot be made to tag or link someone through a card's name", () => {
    const post = resultsPost({ breakId: 0n, cards: 1, wallets: 1, topHit: { name: "Gift for @victim https://evil.example", winner: "4F7B…rzUw" } });
    expect(post).toBe("Break #1 results: Gift for victim → 4F7B…rzUw.");
  });

  it("keeps every post within X's limit with the longest inputs", () => {
    const longest = [
      reservePost({ breakId: 99_999n, percent: 75, target: 9_999_999_000_000n }),
      openPost({ breakId: 99_999n, paid: 65_535, free: 16, price: 9_999_999_000_000n, machine: "m".repeat(40), closesAt: 1_800_021_600n }),
      reminderPost({ breakId: 99_999n, left: 65_535, secsLeft: 24 * 3600 }),
      resultsPost({ breakId: 99_999n, cards: 65_535, wallets: 65_535, link: "https://example.org/a/long/path/to/the/results/page/of/this/break/99999" }),
      resultsPost({ breakId: 99_999n, cards: 1, wallets: 1, topHit: { name: "n".repeat(100), winner: "@fifteen_chars_x" }, link: "https://example.org/breaks/99999" }),
    ];
    for (const post of longest) expect(tweetLength(post), post).toBeLessThanOrEqual(MAX_POST_LENGTH);
  });
});
