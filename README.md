# BREAKS (working name)

Token-gated Collector Crypt pack breaks on Solana. Trading fees fill a treasury reserve; when it can fund a break, spots open. Paid spots are bought in USDC, some spots are free for coin holders. At the deadline the keeper buys one pack per spot and the pulled cards are randomly assigned across the spots.

The full spec, rules and build phases are in [CLAUDE.md](CLAUDE.md). Devnet only.

## Layout

```
programs/treasury   fee reserve (Anchor)
programs/breaks     spot escrow, commits, randomness, claims (Anchor)
keeper/             TypeScript jobs: indexer, eligibility, pack buyer, delivery, bot
web/                Next.js site
db/migrations/      Postgres schema
```

## Run and test

```
pnpm install
pnpm typecheck
pnpm test                    # keeper tests, incl. the DB migrations on an in-memory Postgres
pnpm --filter web build
cargo check --workspace      # Anchor programs, host check only
```

## Status

Phase 1 scaffold. The programs only contain a placeholder `initialize`. The program IDs in `Anchor.toml` and `declare_id!` are placeholders; run `anchor keys sync` once deploy keypairs exist (keypairs never go in git).

Not verified yet: SBF builds and `anchor test`. The Solana/Anchor toolchain could not be downloaded in the cloud session that wrote the scaffold, so those run in CI from Phase 2.
