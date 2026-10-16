# Putting the programs on devnet

This is the order of things from "the programs build" to "the keeper can start". Only the middle step, `setup-devnet`, is
code in this repository; the rest are commands you run yourself (the cloud sandbox this was written in has no Solana
CLI and cannot reach devnet, so none of it was run for real: read each command's `--help` before trusting it).

Devnet only. Nothing here is for mainnet: on mainnet the admin and the upgrade authority are a Squads multisig, not a key file.

## 1. Keys

Make each key outside the repository (`solana-keygen new --outfile <path>`; keep the files mode 600). Never paste a key or
a seed phrase anywhere.

| Key | What it is | Where it is used |
|---|---|---|
| authority | deploys the two programs, is their upgrade authority, and pays the rent of what `setup-devnet` makes | `setup-devnet --authority-keypair` |
| keeper | the hot wallet that drives the pipeline | `KEEPER_KEYPAIR_PATH` of the keeper; `setup-devnet --keeper` takes only its address (`solana-keygen pubkey <file>`) |
| buyer | the hot wallet that receives the pack budget; it has no authority over anything | `setup-devnet --buyer` takes only its address |
| admin | may change the configuration later (`set_split`, `set_keeper`, ...). On devnet it can be the authority itself (the default); on mainnet it must be a multisig | `--admin` (address), and `--admin-keypair` if this tool should send `set_controller` with it |

The tool refuses a keeper that is the admin or the upgrade authority, and a buyer that is any of the three.

## 2. Program ids and the build

The ids in `programs/*/src/lib.rs` and `Anchor.toml` are placeholders. For a deployment, make a key for each program, run
`anchor keys sync` (it writes the ids into the sources), rebuild both programs with `cargo build-sbf`, and deploy them with
those program keypairs and the authority as upgrade authority (`solana program deploy ... --program-id <program keypair>
--upgrade-authority <authority keypair> -u devnet`). A new id changes the addresses the programs derive, so regenerate the
instruction vectors (`UPDATE_VECTORS=1 cargo test -p treasury -p breaks --test instruction_vectors`) if you commit the new ids.

Put the two ids in `keeper/.env` as `BREAKS_PROGRAM_ID` and `TREASURY_PROGRAM_ID`, and in `web/.env` as
`NEXT_PUBLIC_BREAKS_PROGRAM_ID` and `NEXT_PUBLIC_TREASURY_PROGRAM_ID`.

## 3. SOL

The authority needs about 0.0112 SOL for `setup-devnet` (11,114,240 lamports: the rent of the two configuration accounts,
the two vaults and the buyer's USDC account, four transactions' fees, and the 890,880 an account must keep). The keeper
needs 0.0137 SOL to create a break and about 0.0201 SOL for a whole break (`pnpm --filter keeper check-setup` says exactly).
Devnet SOL comes from a faucet.

## 4. The USDC mint

The programs count in USDC's base units (6 decimals) and take the mint from the treasury. Use the USDC mint of devnet
that you want to test with and pass it as `--usdc-mint`; the tool checks that it is an initialized 6-decimal mint of the
classic token program, but it cannot tell whose it is, so confirm the address yourself (this repository does not record
Circle's devnet address: look it up where Circle publishes it).

## 5. `setup-devnet`

```
pnpm --filter keeper setup-devnet -- \
  --authority-keypair ~/.config/breaks/authority.json \
  --keeper <keeper address> --buyer <buyer address> --usdc-mint <devnet USDC mint> \
  --max-paid-spots 48 --max-free-spots 16
```

It reads `SOLANA_RPC_URL`, `BREAKS_PROGRAM_ID`, `TREASURY_PROGRAM_ID` and (optionally) `VRF_PROGRAM_ID` from `keeper/.env`.
Run like this it **only prints** what it would do. Add `--send` to do it. The four steps, each checked against the chain
first, so it can be run again after any interruption:

1. the treasury's `initialize` (admin, split 70/30 by default, USDC mint; makes the config and the two vaults)
2. the breaks program's `initialize` (admin, keeper, buyer wallet, spot limits, sale window 1 to 6 hours by default, ORAO)
3. the treasury's `set_controller`: the breaks program's authority PDA becomes the controller, which is what lets
   `create_break` reserve money
4. the buyer wallet's USDC account

What it does not do: change anything that is already on chain (a value that differs is shown, with what could change it,
and nothing is sent while anything differs or is blocked), initialize a program whose upgrade authority is another key,
or sign as an admin it does not hold. When the admin is not the authority and `--admin-keypair` is not given, it does
everything else and prints the `set_controller` instruction (program, accounts, data) for the admin to send, for example as
a multisig proposal; it then exits with code 3. Exit codes: 0 done (or a clean dry run), 1 something is wrong or a send did
not land, 2 a bad command line, 3 only the admin can finish.

The limits it sets (`--max-paid-spots`, `--max-free-spots`, the window, the split) are ceilings the program enforces on
every break; the break the scheduler makes (`BREAK_*` in the keeper's settings) must fit inside them. The sale window and
the spot limits cannot be changed after `initialize` (there is no instruction for it); the split, the keeper, the buyer wallet
and the randomness program can, by the admin.

## 6. Then

Run `pnpm --filter keeper check-setup`: it reads everything again (the programs, both initializations, the controller, the
reserve against the configured break, the keeper's SOL, the token, the database) and says what is left. Then start the keeper.
