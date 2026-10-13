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
- **Randomness: ORAO VRF** (decided by the owner). One request per break, after `closes_at`, and **after both the eligibility root and the pool hash are committed**. See "Randomness" below. (Switchboard was dropped: news reports say it shut down on 2026-09-25.)
  > PENDING APPROVAL (A4): add a `challenge_period` (30–60 min) between `commit_eligibility` and `request_randomness`. The multisig may void the root (max 2 re-commits) while no seed exists yet.
- **Everything verifiable:** `pack_machine` and `max_pack_price` committed at creation, eligibility root and pool hash committed before the draw, randomness proof stored, all derivations deterministic. The site shows a per-spot ledger: pack purchase tx → Collector Crypt VRF proof → assignment → delivery tx.
- **Known trust gap (MVP):** the chain cannot prove the keeper really bought every pack or delivered every card. The per-spot ledger makes any gap publicly visible. A tighter option is listed in Phase 0.

## Draw algorithm (deterministic, documented on the site)
Implemented in `draw-core/` (pure Rust, shared by the `breaks` program and its tests). `draw-core/vectors.json` holds a fixed example with every output; the TypeScript keeper and the "verify this draw" tool must reproduce it byte for byte (the Rust test fails when the file is stale).
- **Hash:** SHA-256 everywhere (the Solana syscall on-chain).
- **Eligibility tree (Merkle sum tree):** leaves are `(wallet, weight)`, sorted by wallet bytes ascending, strictly increasing (no wallet twice), weight > 0. Leaf hash `H(0x00 ‖ wallet(32) ‖ weight u64 LE)`, sum = weight. Inner hash `H(0x01 ‖ left.hash ‖ left.sum u64 LE ‖ right.hash ‖ right.sum u64 LE)`, sum = left + right (overflow = invalid). An odd node at the end of a level is carried up unchanged (never duplicated, which would count its weight twice). The root hash is committed in `commit_eligibility`, with `total_weight` = root sum. A proof is a list of `(sibling hash, sibling sum, sibling_is_left)`; it proves the leaf's range `[start, start + weight)` in `[0, total_weight)`, where `start` is the sum of the left siblings. So the keeper cannot hand-craft ranges.
- **Free-spot winners, drawn without replacement.** Winner `i` (0, 1, …): `remaining = total_weight − Σ weights of earlier winners`; `r = u128_le(H("breaks:free:v1" ‖ seed ‖ i as u16 LE)[0..16]) mod remaining`; then walk the earlier winners' ranges in ascending order of start and do `if r >= start { r += weight }`; the winner is the leaf whose range contains `r`. This always yields `min(free_spots, eligible)` distinct wallets however skewed the weights are (this replaces the earlier "retry with a nonce, give up after 32 tries" rule, which could fail when one wallet holds almost all the weight, after the pool size was already fixed).
- **`claim_free_spot(index, wallet, weight, proof)`** is permissionless (the keeper submits it) and **in order**: the program recomputes where winner `index` lands, checks the proof against the committed root and total weight, checks the wallet's range contains the drawn position, and records the winner. A wallet that appears in two leaves of a bad tree is refused the second time. When the last winner is recorded the break is `Drawn`; with no free winners it is `Drawn` as soon as the seed is final.
- **Card → spot assignment** (off-chain, anyone can recompute): the pool sorted by card mint (so pull order can't matter); spots are ordered paid spots by purchase order, then free spots in draw order. Fisher–Yates from the back: for `k` from `n−1` down to 1, `j = u128_le(H("breaks:items:v1" ‖ seed ‖ k as u16 LE)[0..16]) mod (k+1)`, swap positions `k` and `j`. Spot `s` gets the card at index `perm[s]` of the sorted pool.
- The eligibility commit also includes `inputs_hash` of the published `balance_events` snapshot, so anyone can recompute TWAB.
- Limits: at most 16 free spots per break (the winner list is stored in the break account); a proof is at most 40 steps, in practice about 14 for thousands of holders, which fits a transaction.

## Randomness

- **Provider:** ORAO VRF, program `VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y` (same address on mainnet and devnet). ORAO's Rust crate targets Anchor 0.32, so we do not use it: `programs/breaks/src/randomness.rs` builds the `request_v2` instruction by hand and reads the request account's bytes. Both layouts are pinned by tests against fixtures generated with the real `orao-solana-vrf` 0.7.0 crate.
- **Flow:** `request_randomness` (seed = `sha256("breaks:randomness:v1" || break || attempt || eligibility_root || pool_hash)`) → ORAO's oracles write 64 bytes (an Ed25519 signature of the seed) into the request account → `settle_randomness` stores `sha256("breaks:seed:v1" || those 64 bytes)` as the draw seed. Anyone can check the 64 bytes against ORAO's public key.
- **Why the seed is safe:** it cannot be known before the eligibility root and the pool hash are committed, so nobody can prepare an answer for it. If a stranger asks ORAO for the same seed first, `breaks` adopts that request.
- **Cost:** ORAO charges a request fee (SOL, or ORAO tokens if its network state is configured that way). The keeper wallet pays it; for token fees the keeper passes ORAO's token accounts as extra accounts.
- **Tests:** `programs/mock-orao` is a TEST-ONLY stand-in with ORAO's `request_v2` interface and account bytes, where anyone can fulfil with any value. It is never deployed with real money. Not yet tested: the real ORAO program itself. Plan: a CI job that dumps ORAO's program and network state from devnet, loads them into LiteSVM, swaps in a test fulfilment authority and runs the same flow with a real signature.
- **Trust left:** ORAO's oracle set (a Byzantine quorum of its authorities) and the ORAO program upgrade authority. The admin can switch to another program with the same interface via `set_randomness`.

## Architecture

### 1. On-chain programs (`programs/`)
**`treasury`**
- `initialize(config)` — admin = Squads multisig; only the program's upgrade authority can call it.
- `deposit_fees(amount)` — splits into `subsidy` / `holder` buckets by config ratio.
- `set_split(subsidy_bps, holder_bps)` — admin only.
- `set_controller(controller)` — admin only. The controller is the `breaks` program's `treasury_authority` PDA.
- `lock_funds` / `unlock_funds` / `pay_from_locked` — controller only. Locking is how the on-chain funding rule works (the treasury refuses unless the bucket has that much unlocked). Pay-outs can only come out of locked funds, so they never touch money reserved for another break.
- Read-only balances for the website: the two vault balances and `locked_subsidy` / `locked_holder` in the config account.

**`breaks`** (built: the whole on-chain flow up to the recorded draw)
- `initialize(params)` — upgrade authority only. Config: admin, keeper, buyer wallet, window and spot limits, pause.
- `set_keeper`, `set_buyer`, `set_paused` — admin only. Pausing stops new breaks, new spots and `fund_purchases`; cancel and refunds always work.
- `create_break(params)` — keeper; locks `paid_spots × (max_pack_price − spot_price)` of subsidy and `free_spots × max_pack_price` of holder funds in the treasury (the funding rule). `spot_price ≤ max_pack_price` is enforced: a markup is not supported yet.
- `buy_spot(index)` — USDC into the break's escrow; one spot account per spot, `index` must be the next free one.
- `close_break` — anyone, after `closes_at`.
- `commit_eligibility(root, total_weight, entry_count, inputs_hash)` — keeper, after close.
- `fund_purchases` — keeper. Pays `pool_size × max_pack_price` to the buyer wallet (escrow + locked subsidy + locked holder funds) and returns the unused locks. The destination is fixed to the configured buyer wallet. **This is the step users trust.** `pool_size` = sold paid spots + `min(free_spots, entry_count)`; an empty pool cannot be funded and is cancelled instead.
- `commit_pool(pool_hash, pool_size)` — keeper, after funding; `pool_size` must match.
- `cancel_break` — admin, before funding; `refund_spot` — anyone, pays the spot's owner.
- `request_randomness` — keeper, after the pool is committed. Asks ORAO for randomness with a seed that commits to the break, the attempt, the eligibility root and the pool hash. The keeper pays ORAO's request fee. If someone already asked ORAO for the same seed, the request is adopted instead of failing. A request that ORAO never answers can be repeated after `randomness_timeout_secs` (at most 5 attempts), but never once it has been answered.
- `settle_randomness` — anyone, once ORAO has answered: stores the seed of the draw (`sha256("breaks:seed:v1" || ORAO's 64 bytes)`). Final.
- `set_randomness(program, timeout_secs)` — admin only: which VRF program to use (ORAO's address in production) and the repeat timeout.
- `claim_free_spot(index, wallet, weight, proof)` — anyone, once the seed is final; records the free-spot winners in order (see "Draw algorithm"). Status flow: … `PoolCommitted` → `RandomnessRequested` → `Settled` → `Drawn`.
- Next: the keeper side of the pipeline (pack buyer, delivery). Open: what happens to buyer-wallet money that is not spent (return path), and the partial-failure policy.

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
programs/treasury   programs/breaks   programs/mock-orao (test only)
draw-core/          (pure logic of the draw + vectors.json for other languages)
testkit/            (shared helpers for the on-chain tests)
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

**Program tests:** each program has pure-logic unit tests (`cargo test -p treasury -p breaks -p draw-core --lib`, runs anywhere) and on-chain tests in `programs/<name>/tests/` that run the compiled program inside LiteSVM. The on-chain tests need `target/deploy/<name>.so` from `cargo build-sbf --manifest-path programs/<name>/Cargo.toml`; without it they fail on purpose.

On-chain tests share helpers in `testkit/` (deploy with an upgrade authority, send, error and event assertions, clock). Both programs' tests need both `.so` files, so build both before `cargo test`.

**Toolchain limit in cloud sessions:** the Solana/Anchor binaries could not be downloaded there (release.anza.xyz and GitHub release downloads were blocked by the network policy), so `cargo build-sbf` and the on-chain tests run in CI (job `programs`), not in the session. Read CI results with the GitHub Actions tools. CI also runs on pushes to `claude/**` branches so work can be verified without opening a pull request. Do not claim on-chain behavior is tested until that job is green.

## Build phases
0. **Feasibility (no code, you run these; the first one gates everything):**
   1. Buy one pack from wallet A, send the card to wallet B, check that B can still sell it back.
   2. Check whether a pack can be bought so the card lands directly in another wallet.
   3. Check for a Collector Crypt / Jupiter Gacha API or terms for programmatic purchases.
   4. Check whether our program could verify a pull from Collector Crypt's on-chain accounts. If yes, release funds per verified pull and close the trust gap.
   5. Check whether the card can be held in a program-owned account (only if an on-chain escrow is wanted).
   6. (done) VRF provider: ORAO.
1. **Scaffold** (merged) — Anchor workspace (2 programs, placeholder instructions), Next.js app, keeper skeleton (config, job runner, `PackProvider` + mock), DB migration v0. Devnet only.
2. **Treasury** (initialize, deposit_fees, set_split; merged). No admin-transfer instruction yet: decide whether to add a two-step handover.
3. **Breaks program** — create/buy/close/commit/fund/cancel/refund, randomness (ORAO) and the free-spot draw, with the treasury lock/pay-out (merged and in review).
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
- A2 weight rule (cap vs linear + cluster merge), A4 challenge window. A1 (randomness provider) is decided: ORAO. A3 from the earlier review is obsolete (no inventory).
- Repo name for the new project.
