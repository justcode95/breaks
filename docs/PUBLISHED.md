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
  account in one slot have no order of their own (they share one block time, so no order changes an area, but it decides what
  the account held before the slot and whether the history adds up): they are put in the first order, trying the published
  order first at every step, in which each event starts (`balance after − change`) where the one before it ended. The first
  starts where the account stood before the slot; when nothing is known of the account (these are its first events) it is an
  event that starts where no other event of the slot ends, or, if they all do, the first in the published order. A slot of
  more than 24 events on one token account is read in the published order, which then has to chain on its own. A history
  where an account would have held less than nothing, or where a change does not lead to the next balance (a transaction is
  missing), is refused, not guessed at.
  A wallet on the list has a weight equal to its TWAB unless the break's rules cap it (a rule that is still being decided);
  the wallets that are not on the list are below the minimum or left out on purpose, and the reasons are not published yet.
- **Cards.** `sha256("breaks:pool:v1" ‖ mint_0 ‖ mint_1 ‖ …)` over the sorted mints must equal the file's name and the
  `poolHash` on the break's account, and the number of cards `poolSize`.

The site's "Verify a draw" page recomputes the draw from these (its own implementation of the tree and the hash, not the
keeper's).

`docs/twab-vectors.json` is the TWAB made by the keeper's own code from texts in this format: a few dozen cases (every kind of
refusal, the same-slot rules, and random histories), each the text and the TWAB of every owner or the kind of refusal. The
keeper's test fails when the file is stale (`UPDATE_TWAB_VECTORS=1 pnpm --filter keeper test` rewrites it), and the
website's own implementation (`web/lib/twab/`) is tested against it, so the two cannot drift apart.

## How the website reads them

Set `NEXT_PUBLIC_PUBLISHED_URL` when the site is built to the folder the files are served from (https, or http on this
machine only; no login, query or fragment in it). When a person loads a break on the "Verify a draw" page, the page
fetches `<folder>/eligibility/<root>.json` once a list is committed, `<folder>/inputs/<inputs hash>.txt` as soon as the
inputs hash is committed (with the list), and `<folder>/pool/<pool hash>.json` once the seed is final, **using the root, the
inputs hash and the pool hash it just read from the break's account**. It then checks each file before using it:

- the file is the kind and version it expects, and the root or pool hash inside is the one it is named after;
- every wallet is a Solana address, every weight a whole number from 1 to 2^64 − 1, no wallet twice, in the tree's order;
- the wallets and weights, hashed with the page's own tree, give the committed root; their sum is the committed total
  weight and their number the committed count (for the cards: the committed pool hash and the committed number of cards);
- the balance events: the SHA-256 of the text is the break account's `eligibilityInputsHash`;
- the file is not larger than 25 MB.

A file that fails any of these is not used: the page says why, in words, and leaves the list or the cards to be pasted. A
file that is missing, or a host that cannot be reached, is said the same way. Reading the files never stops the break
from loading. Text read from the files is replaced when another break is loaded; text a person typed is left alone.

With the balance events the page also **checks the weights**: it reads the text strictly, computes every wallet's TWAB by the
definition above (its own implementation, not the keeper's), and compares each weight on the list with the wallet's TWAB. A
weight that is equal is as it should be; one that is below the TWAB can only be explained by a cap on a wallet's weight (a rule
that is still being decided); one that is above it, or for a wallet with no balance events at all, cannot be explained. The
wallets that have a TWAB above zero and are not on the list are shown too (below the minimum, or left out on purpose: the
reasons are not published yet). The text's window is compared with the break's `opens_at` to `closes_at`. None of this stops the
draw itself from being checked.

The only thing a request contains is the file's name (a hash from the chain): no cookies, no `Referer`, no credentials.
The break's page links the same files.

`docs/published-example/` holds a small list and pool made by the keeper's own code. The keeper's tests pin them, and the
website's tests read and check them, so the two sides cannot drift apart on the format. Regenerate them with
`UPDATE_PUBLISHED_EXAMPLE=1 pnpm --filter keeper test` if the format ever changes on purpose.

## Not published yet

- Every wallet's TWAB and why a wallet is out (they are in the keeper's `published_documents`; no public channel for
  them yet, and nothing the chain commits to names them). The inputs file above is what lets anyone recompute the TWAB
  itself; the minimum, a cap if there is one, and the reasons for being left out are the part that is not public yet.
- The exclusion list (`exclusions`).
- A smaller form of the inputs file. It lists every balance event since the token's launch, which is fine for thousands of
  holders and will not be for a very busy token.
