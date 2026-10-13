# Project: Token-gated Collector Crypt pack breaks on Solana

> Working name: TBD (shortlist: Full Table $TABLE, Free Spot $SPOT, Key Issue $KEY). Use `BREAKS` as placeholder in code until decided.
>
> **Draft v2.** The model change (gacha packs and a shared pool instead of a vault of slabs) comes from you. Blocks marked `PENDING APPROVAL` are my proposals and are not decisions yet. See "Pending items" at the end. Remove the markers once settled.

## What we're building
A Solana memecoin whose trading fees fund group "breaks" of Collector Crypt gacha packs. On the website, players buy paid spots in USDC; some spots in every break are **free for coin holders**, drawn by verifiable randomness. At the deadline the keeper buys one pack per spot, pulls them all, and the pulled cards are randomly assigned across the spots and sent to the winners' wallets. Winners keep a card or sell it back on Collector Crypt. Everything runs automatically: break scheduling, draws, pack buying, delivery, website, and an X bot.

### Problems this design fixes (vs. the old model)
1. Big breaks stalled when fee volume was low → fees accumulate in a **treasury reserve**; breaks are only created when the reserve can fund them.
2. Breaks stayed open for hours waiting to fill → **fixed deadline**; an unfilled paid spot is simply not bought, so the pool is smaller. Nothing ever waits.
3. Non-payers had no way in → **free holder spots** in every break.

## Core rules (product decisions — don't change without asking)
- **Chain:** Solana. Programs in Anchor (Rust). Off-chain in TypeScript.
- **Fees:** launchpad creator fees land in a Squads multisig; the keeper sweeps them into the treasury program, which splits them into buckets:
  - `subsidy` (default 70%): tops up the cost of paid spots (if `spot_price < pack_price`)
  - `holder` (default 30%): pays for free holder spots
  - Split is a config value set by admin (multisig).
  - Fees arrive in SOL; the keeper swaps to USDC (Jupiter, slippage cap, per-sweep size cap) before depositing. The treasury is USDC-only.
- **Breaks are fee-funded from the first one.** No team pre-funding. A break can only be created when the buckets can cover its worst case:
  `free_spots × max_pack_price + paid_spots × max(0, max_pack_price − spot_price)` (all paid spots fill). The first break auto-opens as soon as the reserve crosses that threshold; the second the same way. The site shows a public progress bar ("Break #1 unlocks at $X — currently Y%"). With no vault or inventory to buy first, break #1 unlocks at pack cost, not prize value.
- **Break shape:** `paid_spots` (max, e.g. 10), `free_spots` (e.g. 2–4), `spot_price` in USDC, `pack_machine` (one Collector Crypt machine/price tier per break, so every spot is equivalent), `max_pack_price`, `opens_at`, `closes_at` (6–24h window).
- **At the deadline:** pool size = filled paid spots + free spots (fewer if too few holders are eligible). The keeper buys exactly one pack per spot and pulls them. Unfilled paid spots are not bought. No house fills.
- **Shared pool:** all pulled cards go into one pool and are randomly assigned across the spots. This stops the keeper from steering a good pull to a chosen wallet. Spots are ordered: paid by purchase order, then free spots in draw order.
- **Pack randomness is Collector Crypt's.** Each pull uses Collector Crypt's on-chain VRF (per Jupiter's docs, with a per-pull proof). Our randomness covers only the free-spot draw and the card-to-spot assignment.
- **No staking (for now).** Free-spot eligibility = holding, measured by **time-weighted average balance (TWAB) over the break window** (`opens_at` → `closes_at`).
  - Minimum TWAB to be eligible (e.g. 1M tokens — config).
  - Weight = TWAB, **capped per wallet** (config) so whales can't dominate and splitting wallets gives no edge.
  - Exclude: LP pools, exchange wallets, team wallets, flagged bundle/sniper wallets. Exclusion list is public.
  - Staking may be added later as an extra weight multiplier — keep the eligibility module pluggable.
  > PENDING APPROVAL (A2): the cap rewards splitting (10× the cap in one wallet = 1× weight; split into ten wallets = 10×). Proposal: linear weight (no cap or a high sanity cap), keep the min TWAB, one spot per wallet, and merge wallets funded from the same source into one entity (published, with reason codes).
- **Randomness:** one request per break, after `closes_at`, and **after both the eligibility root and the pool hash are committed**. Provider sits behind an adapter.
  > PENDING APPROVAL (A1): news reports say Switchboard shut down on 2026-09-25 (unconfirmed by me; check their channels). Candidates: ORAO VRF, MagicBlock VRF. Verify audit status, devnet support, and who can withhold a fulfilment.
  > PENDING APPROVAL (A4): add a `challenge_period` (30–60 min) between `commit_eligibility` and `request_randomness`. The multisig may void the root (max 2 re-commits) while no seed exists yet.
- **Everything verifiable:** `pack_machine` and `max_pack_price` committed at creation, eligibility root and pool hash committed before the draw, randomness proof stored, all derivations deterministic. The site shows a per-spot ledger: pack purchase tx → Collector Crypt VRF proof → assignment → delivery tx.
- **Known trust gap (MVP):** the chain cannot prove the keeper really bought every pack or delivered every card. The per-spot ledger makes any gap publicly visible. A tighter option is listed in Phase 0.

## Draw algorithm (deterministic, documented on the site)
- **Free-spot winners:** eligible wallets sorted by address, in a Merkle **sum** tree (each node commits `(hash, sum_of_weights)`), so ranges are derived from the proof and can't be hand-crafted. Leaf = `wallet(32) ‖ weight(u64 LE)`, with distinct leaf/node prefixes. For winner `i`: `r_i = H(seed, "free", i, n) mod total_weight`, `n = 0,1,…` until the wallet is new (max 32 tries, then the spot is dropped). Claims are verified on-chain with the proof; `claim_free_spot` is permissionless (the keeper submits it).
- **Card → spot assignment:** pool sorted by card mint (so pull order can't matter), then Fisher–Yates with `j = H(seed, "items", k) mod (k+1)`.
- `H` = keccak256 (or SHA-256), fixed in the program and in the verify tool.
- The eligibility commit also includes `inputs_hash` of the published `balance_events` snapshot, so anyone can recompute TWAB.

## Architecture

### 1. On-chain programs (`programs/`)
**`treasury`**
- `initialize(config)` — admin = Squads multisig.
- `deposit_fees(amount)` — splits into `subsidy` / `holder` buckets by config ratio.
- `set_split(subsidy_bps, holder_bps)` — admin only.
- Read-only balances for the website.

**`breaks`**
- `create_break(params)` — keeper/admin; checks the funding rule; locks the worst-case amount from the buckets.
- `buy_spot(break_id)` — USDC into escrow; records a spot PDA.
- `close_break(break_id)` — after `closes_at`; fixes the filled paid spots.
- `commit_eligibility(break_id, root, total_weight, entry_count, inputs_hash)` — keeper.
- `fund_purchases(break_id)` — releases the pack budget (`pool_size × max_pack_price` at most) to the buyer wallet. **This is the step users trust.**
- `commit_pool(break_id, pool_hash, pool_size)` — keeper, after the pulls.
- `request_randomness(break_id)` / `settle_randomness(break_id)` — settle is permissionless; re-request only if unfulfilled after a timeout, never after a fulfilled seed.
- `claim_free_spot(break_id, index, leaf, proof)` — permissionless; unclaimed after N hours → the spot is dropped.
- `cancel_break` — full refunds, allowed before `fund_purchases` only. Admin: `pause`, config updates. All admin = multisig.
- Unspent buyer-wallet funds return to the treasury or to refunds for any spot that could not be bought.

No vault program. Cards pass through the buyer wallet. An on-chain escrow for cards is only added if Phase 0 shows it is possible.

### 2. Keeper (`keeper/`, TypeScript, runs on a server)
Jobs:
- **Fee sweep** — SOL → USDC swap, then `deposit_fees` (multisig-approved or a delegated sweeper with a spend cap).
- **Break scheduler** — create a break when the reserve crosses the threshold.
- **Balance indexer** — Helius webhooks/geyser for every token transfer → Postgres.
- **TWAB + eligibility** — at `closes_at`, compute TWAB per wallet, apply min/exclusions, build the sum tree, `commit_eligibility`, publish the list and the `balance_events` snapshot (site + IPFS/Arweave).
- **Pack buyer** (`PackProvider` interface; a mock on devnet) — one pack per spot from the buyer wallet. A state machine per `(break, spot_index)`: `planned → submitted(sig) → confirmed → pulled(card_mint)`. Never submit a second buy for an index until the first signature is confirmed failed or expired, and on restart reconcile with the wallet's history first. A double-buy costs real money. Abort if the live price exceeds `max_pack_price`.
- **Pool commit → randomness → delivery** pipeline. Transfer each card to its winner within minutes of the seed settling, because Collector Crypt's sellback window is about 72 hours from the pull. Create ATAs; keeper pays the rent.
- **X bot** (see below).
- Every step safe to re-run.

### 3. Database (`db/`, Postgres / Supabase)
Minimum tables: `breaks`, `spots`, `packs` (spot_index, purchase_tx, card_mint, proof_ref), `deliveries`, `balance_events`, `twab_snapshots`, `eligibility_lists`, `draws`, `treasury_events`, `exclusions`, `x_links` (wallet ↔ X handle via signed message, with consent), `bot_posts`.

### 4. Website (`web/`, Next.js + Solana wallet adapter)
- **Home / live break** — machine and its published odds, spots left, countdown, buy-spot button, reserve progress bar toward the next break. There is no item list in advance; the "chase" is the machine's top tier.
- **Break detail** — spots, free-spot rules, live reveal when cards are delivered.
- **My dashboard** — wallet balance, current TWAB, eligible yes/no, estimated chance of a free spot, past cards (with sellback deadline), link X handle.
- **Transparency** — treasury buckets, exclusion list, every past break with eligibility list + root, pool hash, randomness proof, the per-spot ledger, and a "verify this draw" tool that recomputes eligibility and assignment client-side.
- **How it works** — plain-language fees → reserve → breaks → free spots → packs.

### 5. X bot (`keeper/bot/`)
Uses the X API (pay-per-use in 2026; posts containing a URL cost much more than plain posts per third-party summaries, so confirm in X's console and keep links to the results post or a reply). Account labeled as automated. Templates:
- Reserve milestone: "Break #{n} is {pct}% funded 🔥 Unlocks at ${target}."
- Break open: "Break #{n} is LIVE — {paid} paid spots @ ${price} + {free} FREE holder spots. Packs: {machine}. Closes {time}."
- Spots reminder: "{left} spots left in Break #{n}. Closes in {h}h."
- Free spot winners: "Free holder spots in Break #{n} go to {handles_or_short_wallets} 🎉" (only tag opted-in handles)
- Results: "Break #{n} results: {top_hit} → {winner}. Full results + proof: {link}"
Rate-limit, dedupe via `bot_posts`, never post before the on-chain event is **finalized**.

## Repo layout
```
programs/treasury   programs/breaks
keeper/             (jobs, indexer, buyer, bot)
web/                (Next.js)
db/                 (migrations)
tests/              (Anchor tests: every instruction, happy + failure paths; added in Phase 2)
scripts/            (devnet setup; added when needed)
```

The mock `PackProvider` lives in `keeper/src/pack-provider.ts`. Root files: `Anchor.toml`, `Cargo.toml` (Rust workspace), `pnpm-workspace.yaml` (keeper + web).

## Run and test
```
pnpm install
pnpm typecheck
pnpm test                    # keeper tests, incl. db/migrations applied on an in-memory Postgres (PGlite)
pnpm --filter web build
cargo check --workspace      # Anchor programs, host check only
```
CI (`.github/workflows/ci.yml`) runs the same on every pull request and on pushes to main.

**Toolchain limit in cloud sessions:** the Solana/Anchor binaries could not be downloaded there (release.anza.xyz and GitHub release downloads were blocked by the network policy), so SBF builds and `anchor test` have not been run anywhere yet. Phase 2 adds a CI job for them. Until then, program logic is only host-checked; do not claim it is tested.

## Build phases
0. **Feasibility (no code, you run these; the first one gates everything):**
   1. Buy one pack from wallet A, send the card to wallet B, check that B can still sell it back.
   2. Check whether a pack can be bought so the card lands directly in another wallet.
   3. Check for a Collector Crypt / Jupiter Gacha API or terms for programmatic purchases.
   4. Check whether our program could verify a pull from Collector Crypt's on-chain accounts. If yes, release funds per verified pull and close the trust gap.
   5. Check whether the card can be held in a program-owned account (only if an on-chain escrow is wanted).
   6. Pick the VRF provider (A1).
1. **Scaffold** (done, in review) — Anchor workspace (2 programs, placeholder instructions), Next.js app, keeper skeleton (config, job runner, `PackProvider` + mock), DB migration v0. Devnet only.
2. **Treasury** with full tests.
3. **Breaks program** — create/buy/close/fund/cancel with tests. Then randomness + claims + pool commit.
4. **Keeper** — indexer, TWAB, eligibility, scheduler, pack buyer, delivery, pipeline.
5. **Website** — live break, dashboard, transparency + verify tool.
6. **X bot.**
7. **Hardening** — admin panel, monitoring/alerts, external audit, then mainnet with small breaks.

## Guardrails for Claude Code
- **Devnet only** until the user explicitly says otherwise after an audit. Collector Crypt is a mainnet service, so the pack buyer runs against a mock on devnet. Real Collector Crypt tests are manual and run by the user.
- Never commit private keys, seed phrases, or API keys. Use `.env` (gitignored) and `.env.example`.
- All admin/authority roles and program upgrade authority → Squads multisig, never a single hot wallet.
- **Exception: the buyer wallet.** It holds only the pack budget funded per break, up to the cap in `fund_purchases`, and has no authority over any program.
- Every program instruction gets tests for success and failure cases before moving on.
- Keeper steps must be idempotent and retry-safe, especially the pack buyer.
- Ask before changing any rule in "Core rules".

## Open decisions
- Coin name/ticker (a ticker is not unique on Solana, so check the X handle, domain, trademark, and clone risk).
- Which Collector Crypt machine(s) and price tier; whether other collectibles are added later.
- Exact numbers: spot price (vs pack price), paid/free spot counts, window length, min TWAB, fee split.
- Partial-failure policy if fewer packs can be bought than spots (proposal: refund the last paid spots by purchase order, drop free spots last).
- Legal review (paid randomized prizes are treated as gambling in Belgium; selling gacha pulls; token/fee structure may raise securities questions; Collector Crypt's terms) — before mainnet.

## Pending items (need your yes/no)
- A1 randomness provider (Switchboard out), A2 weight rule (cap vs linear + cluster merge), A4 challenge window. A3 from the earlier review is obsolete (no inventory).
- Repo name for the new project.
