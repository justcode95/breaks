# Phase 0: Collector Crypt feasibility

The real pack buyer and card delivery cannot be written until these questions have answers, because every one of them
changes the code. Phase 0 is yours to run (small amounts, by hand, from your own wallets); the keeper never buys a real
pack. This page says what is already public, what is still unknown, exactly what to do, and what each result means.

## 1. What is publicly documented

Found by searching; the Jupiter and Collector Crypt pages themselves could not be opened from the cloud sandbox, so
treat these as summaries to confirm, not as quotes.

| Fact | Source |
|---|---|
| Jupiter Gacha is built with Collector Crypt. Each card is a token on Solana that represents a vaulted physical graded card. | [Jupiter gacha docs](https://docs.jup.ag/user-docs/trade/gacha), [FAQ](https://docs.jup.ag/user-docs/trade/gacha/faq) |
| A pack costs its price in USDC plus a little SOL for fees; every opening is a Solana transaction; Jupiter charges no platform fee. | [Opening packs](https://docs.jup.ag/user-docs/trade/gacha/opening-packs) |
| Every pull uses Collector Crypt's on-chain VRF (`cc-vrf`, RFC 9381 ECVRF) with a per-pull proof, shown under Collection > Activity > Verify. The code is said to live at `github.com/collectorcrypt/cc-vrf` (not opened; the program id was not found). | [Verifiable randomness](https://docs.jup.ag/user-docs/trade/gacha/verifiable-randomness) |
| Instant buyback: at least 85% of the card's insured value, paid in USDC, available for 3 days after the pull, cannot be extended or reopened. | [Instant buyback](https://docs.jup.ag/user-docs/trade/gacha/instant-buyback) |
| Packs can be gifted to another wallet (a gift to a wrong address cannot be recovered). What exactly is gifted (an unopened pack? who opens it?) was not read. | [Gifting](https://docs.jup.ag/user-docs/trade/gacha/gifting) |
| A machine that runs low on higher rarities is disabled until restocked, and the interface can lag behind the chain. | [FAQ](https://docs.jup.ag/user-docs/trade/gacha/faq) |

**Not found anywhere public:** a developer API or terms for buying packs programmatically; the program ids; how the
purchase transaction is built; what token standard the card is; whether a card can still be sold back after it has been
transferred. A third-party page claims the roll is derived from the buyer's transaction signature and deviates from the
RFC; that was not confirmed ([Yellow](https://yellow.com/asset/cards)).

## 2. What the code is waiting for

| Unknown | What it changes |
|---|---|
| Who builds and signs the purchase transaction. If Collector Crypt's backend builds it and co-signs, our code cannot add a memo, and only their service can produce it. | `PackProvider.findExisting`/`prepare`: the buyer's "never buy twice" rule searches the buyer wallet's history for a memo (`packMemo`). Without a memo it needs another way to tell which purchase belongs to which pack (for example one signature recorded before sending, matched to the wallet's pulls). |
| How the pull is read: in the purchase transaction itself, or in a later one; which account or event holds the card mint and the proof. | `PackProvider.reveal` and `proof_ref`. |
| Whether a pack can be bought so the card lands in another wallet (gifting, or a recipient field). | If yes, the buyer could buy for the recipient directly and `CardTransfer` shrinks or disappears. See "An option to decide" below. |
| What the card is (Metaplex Core, Token Metadata, other), who the update/transfer authority is, whether it is frozen or has a transfer delegate. | `CardTransfer.prepare` (how to move it, who pays the new token account) and whether it can move at all. |
| Whether sellback still works after the card is transferred to another wallet, and from which wallet. | Whether delivering by transfer takes the winner's 3-day sellback away. This decides whether the delivery design works at all. |
| A programmatic route: an API, terms that allow automated purchases, limits. | Whether the pack buyer can run unattended, or a person must press the button and the keeper only verifies. |
| The program ids and the cc-vrf proof layout. | The reader for `reveal`, and the "verify this draw" page. |

## 3. What to do

Use small amounts and fresh wallets. Never paste a private key or seed phrase anywhere, and never paste an RPC url that
contains an API key.

1. **Buy one pack by hand** from wallet A, in the cheapest machine of the tier you plan to use. Note the purchase
   transaction signature, the card you got, and, from the Verify screen, the randomness proof.
2. **Look at what the web app sends.** Open the browser's developer tools (Network tab) before you buy, buy, and note
   the requests that go to a server of Jupiter or Collector Crypt (URL paths and the shape of the JSON, without cookies or
   headers). A request that returns a ready-to-sign transaction means their backend builds it.
3. **Move the card**: send it from A to a second wallet B with a normal wallet transfer. Note the signature. If the app or
   the token blocks the transfer, note the message.
4. **Try the sellback from B** (within 3 days of the pull). Does the app offer it for a card that B received? Does it work? If
   you can, also try from A. Note every signature and every message.
5. **Try a gift**, if the app offers it: gift a pack to wallet B and note what B receives (a pack to open, or a card),
   who opens it, and the signatures.
6. **Read `cc-vrf`** (`github.com/collectorcrypt/cc-vrf`): the program id, where a pull's proof and result are stored, how
   to read them from a purchase signature.
7. **Ask**: write to Collector Crypt and Jupiter: is there an API or terms for programmatic purchases, are there limits,
   is automated buying allowed, can a business buy several packs in one go, what are the terms of the buyback.

Then run the inspector on each transaction (section 5) and send me the report plus your notes from steps 2 to 7.

## 4. What the answers mean

| If you find... | Then... |
|---|---|
| The purchase has a signer besides the buyer (a Collector Crypt key) | Their service builds it. The memo rule cannot be used as it is; I redesign `findExisting` around what the wallet history shows. Automation also depends on their API being open to us. |
| Only the buyer signs and the program accepts extra instructions | Our code can build the purchase and add the memo. The port stays as it is. |
| The sellback works from the receiving wallet B | Delivering by transfer is fine. |
| The sellback only works for the wallet that opened the pack | Delivery by transfer takes away the winner's sellback. The shared-pool design needs an owner decision (below). |
| No API and no terms for automation | The keeper cannot buy unattended. The fallback is a person buying the packs (with the funded buyer wallet) while the keeper checks every pull on-chain; the trust gap grows and the owner decides if that is acceptable. |
| The card is frozen, or its transfer needs Collector Crypt | It cannot be delivered by a normal transfer; the design needs their cooperation. |

## An option to decide (not a decision I can make)

Gifting might let the keeper buy a pack and gift it, unopened, to a winner's wallet, who opens it. Then no card ever has
to be transferred (so nothing can break the sellback), and the keeper never sees a pull before the winner does, which
removes the "steering" worry that the shared pool exists for. It would change a core rule: today the cards are pulled
first, pooled, then randomly assigned. Whether that is acceptable (winners must open their own packs; every spot gets an
independent pull instead of a shared draw) is for the owner to say after step 5. Nothing is built for it.

## 5. The inspector

```
pnpm --filter keeper phase0 -- --rpc <your RPC url> --das \
  purchase=<signature> transfer=<signature> sellback=<signature>
```

Use an RPC url for the cluster the transactions are on (mainnet, since Collector Crypt is a mainnet service); `--das` also
asks the node for the asset record of the card (needs a provider that supports DAS, such as Helius). It only reads: it
sends nothing, holds no key, and never prints the url. For each transaction it prints who signed (and whether anyone besides
the fee payer did), the programs involved, each instruction with the first bytes of its data, where the USDC went, which
1-of-1 token arrived and in whose wallet, the accounts created and their owner programs, any memo, and the logs, with a
short list of notes pointing at the questions above. Paste the output back as it is.
