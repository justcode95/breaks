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
pnpm --filter keeper dev      # run the keeper (needs keeper/.env, see keeper/.env.example; devnet only)
cargo check --workspace      # Anchor programs, host check only
```

## Status

- Phase 1 (scaffold): merged.
- Phase 2 (treasury program): `initialize`, `deposit_fees`, `set_split` with unit tests and on-chain LiteSVM tests. Needs CI to build for SBF; see CLAUDE.md "Run and test".
- The `breaks` program only has a placeholder `initialize`. Program IDs in `Anchor.toml` and `declare_id!` are placeholders; run `anchor keys sync` once deploy keypairs exist (keypairs never go in git).
