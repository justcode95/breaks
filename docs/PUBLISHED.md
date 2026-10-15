# Published lists

The chain commits to three things before a draw: the eligible wallets (a Merkle root), the balance events those weights
were computed from (a hash, `inputs_hash`) and the pulled cards (a hash). A commitment is only worth something if what is
behind it can be read, so the keeper publishes all three as plain files.

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
- the balance events: the SHA-256 of the stored text equals the `inputs_hash` in the break's account (and the one the
  keeper stored). It is published from the committed list on, and also when nobody was eligible: that is when a reader most
  wants to see why;
- the cards: the pool hash and the number of cards equal the ones committed by `commit_pool`, and the seed is final
  (`Settled` or `Drawn`), so the draw can be checked.

Files are never overwritten. A run first looks for the file by name, so a quiet run reads nothing from the chain.

## Layout

```
eligibility/<root>.json        root = the 64 hex digits committed in `commit_eligibility`
inputs/<inputs hash>.txt       inputs hash = the 64 hex digits of `inputs_hash`, committed in `commit_eligibility`
pool/<pool hash>.json          pool hash = the 64 hex digits committed in `commit_pool`
```

No eligibility file is published for a break whose list is empty (a zero root has nothing behind it); its inputs file
still is.

## Formats

Compact JSON, one line, a newline at the end. The bytes are fixed by the data, so the same list is always the same file.
Numbers that can exceed 2^53 (weights) are decimal strings.

```json
{"version":1,"kind":"eligibility","root":"<64 hex>","totalWeight":"<decimal>","entryCount":2,"entries":[{"wallet":"<base58>","weight":"<decimal>"}, ...]}
{"version":1,"kind":"pool","poolHash":"<64 hex>","cards":["<mint base58>", ...]}
```

The inputs file is text, not JSON: the exact bytes the hash was made from.

```
breaks:inputs:v1,<window start>,<window end>
<signature>,<slot>,<time>,<owner>,<token account>,<delta>,<balance after>
<signature>,<slot>,<time>,<owner>,<token account>,<delta>,<balance after>
...
```

Every line ends with a line feed, including the last. The window is in Unix seconds (`start` included, `end` excluded), one
line follows for every balance event of the token before the end of the window, in chronological order (by time, then slot, signature, token account and owner),
and amounts are whole token base units. A change of owner is two lines, one for each wallet.

- `entries` are in the order the tree uses: sorted by the wallets' 32 bytes, strictly increasing, weights above zero.
- `cards` are sorted by the mints' 32 bytes, with no duplicates.

## How to check a file

- **Eligibility.** Build the Merkle sum tree from `entries` as described under "Draw algorithm" in `CLAUDE.md` (leaf hash
  `H(0x00 ‖ wallet ‖ weight u64 LE)`, inner hash `H(0x01 ‖ left.hash ‖ left.sum ‖ right.hash ‖ right.sum)`, an odd node
  carried up unchanged). The root must equal the file's name and the `eligibilityRoot` on the break's account; the root's sum
  must equal `eligibilityTotalWeight`, and the number of entries `eligibilityCount`.
- **Balance events.** The SHA-256 of the file's bytes must equal the file's name and the `eligibilityInputsHash` on the break's
  account. Then the weights can be recomputed from the history: a wallet's balance at a time `t` is the sum, over its token
  accounts, of the balance after each account's last event at or before `t`; an account that has no event before `t` (or
  before the window) is taken to have held `balance after − delta` of its first event until then; the TWAB is the area under
  that balance over the window divided by the window's length, rounded down to a whole base unit. Several events of one token
  account in one slot have no order of their own: they are put in the order in which each starts where the one before it ended.
  A wallet on the list has a weight equal to its TWAB unless the break's rules cap it (a rule that is still being decided);
  the wallets that are not on the list are below the minimum or left out on purpose, and the reasons are not published yet.
- **Cards.** `sha256("breaks:pool:v1" ‖ mint_0 ‖ mint_1 ‖ …)` over the sorted mints must equal the file's name and the
  `poolHash` on the break's account, and the number of cards `poolSize`.

The site's "Verify a draw" page recomputes the draw from these (its own implementation of the tree and the hash, not the
keeper's).

## Not published yet

- Every wallet's TWAB and why a wallet is out (they are in the keeper's `published_documents`; no public channel for
  them yet, and nothing the chain commits to names them). The inputs file above is what lets anyone recompute the TWAB
  itself; the minimum, a cap if there is one, and the reasons for being left out are the part that is not public yet.
- The exclusion list (`exclusions`).
- A smaller form of the inputs file. It lists every balance event since the token's launch, which is fine for thousands of
  holders and will not be for a very busy token.
