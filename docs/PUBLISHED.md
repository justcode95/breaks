# Published lists

The chain commits to two lists before a draw: the eligible wallets (a Merkle root) and the pulled cards (a hash). A
commitment is only worth something if the list behind it can be read, so the keeper publishes both as plain files.

Each file is **named by the hash the chain committed**. A reader fetches the file for a break's root or pool hash,
recomputes the hash from what is in the file, and compares it with the chain. Where the files are hosted does not matter,
and a host that serves a wrong or altered file is caught: it does not hash to its name. That is why nothing here needs to
be trusted.

## Where the files come from

The keeper job `publish` (on when `PUBLISH_DIR` is set; `PUBLISH_INTERVAL_SECS`, default 60) writes into that directory.
Serve the directory over https from any static host, with `Access-Control-Allow-Origin: *` so the site's pages can read
it. Files never change once written, so they can be cached for good.

A file is written only when the keeper's own data provably hashes to what the chain says, read at **`finalized`**:

- the eligibility list: the Merkle root, total weight and number of wallets rebuilt from the stored list equal the ones
  in the break's account. A list that does not match is reported (an error in the log on every run) and never published;
- the cards: the pool hash and the number of cards equal the ones committed by `commit_pool`, and the seed is final
  (`Settled` or `Drawn`), so the draw can be checked.

Files are never overwritten. A run first looks for the file by name, so a quiet run reads nothing from the chain.

## Layout

```
eligibility/<root>.json        root = the 64 hex digits committed in `commit_eligibility`
pool/<pool hash>.json          pool hash = the 64 hex digits committed in `commit_pool`
```

Nothing is published for a break whose list is empty (a zero root has nothing behind it).

## Formats

Compact JSON, one line, a newline at the end. The bytes are fixed by the data, so the same list is always the same file.
Numbers that can exceed 2^53 (weights) are decimal strings.

```json
{"version":1,"kind":"eligibility","root":"<64 hex>","totalWeight":"<decimal>","entryCount":2,"entries":[{"wallet":"<base58>","weight":"<decimal>"}, ...]}
{"version":1,"kind":"pool","poolHash":"<64 hex>","cards":["<mint base58>", ...]}
```

- `entries` are in the order the tree uses: sorted by the wallets' 32 bytes, strictly increasing, weights above zero.
- `cards` are sorted by the mints' 32 bytes, with no duplicates.

## How to check a file

- **Eligibility.** Build the Merkle sum tree from `entries` as described under "Draw algorithm" in `CLAUDE.md` (leaf hash
  `H(0x00 ‖ wallet ‖ weight u64 LE)`, inner hash `H(0x01 ‖ left.hash ‖ left.sum ‖ right.hash ‖ right.sum)`, an odd node
  carried up unchanged). The root must equal the file's name and the `eligibilityRoot` on the break's account; the root's sum
  must equal `eligibilityTotalWeight`, and the number of entries `eligibilityCount`.
- **Cards.** `sha256("breaks:pool:v1" ‖ mint_0 ‖ mint_1 ‖ …)` over the sorted mints must equal the file's name and the
  `poolHash` on the break's account, and the number of cards `poolSize`.

The site's "Verify a draw" page recomputes the draw from these (its own implementation of the tree and the hash, not the
keeper's).

## Not published yet

- The exact balance-event text that `inputs_hash` commits to, and every wallet's TWAB and why a wallet is out (they are in
  the keeper's `published_documents`; no public channel for them yet). They are what lets anyone recompute the
  weights from the token's history, which is a different check from the one above.
- The exclusion list (`exclusions`).
