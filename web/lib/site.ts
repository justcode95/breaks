// The site's chain settings, from the environment the site was built with. The `NEXT_PUBLIC_` values have to be written
// out like this for the build to put them into the page.

import { breakShapeSetup, chainSetup, publishedSetup, tokenSetup, treasurySetup } from "./config";

export const SETUP = chainSetup({ rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL, program: process.env.NEXT_PUBLIC_BREAKS_PROGRAM_ID });
export const TREASURY_SETUP = treasurySetup({ rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL, program: process.env.NEXT_PUBLIC_TREASURY_PROGRAM_ID });
export const PUBLISHED_SETUP = publishedSetup(process.env.NEXT_PUBLIC_PUBLISHED_URL);
/** The coin, for the wallet's balance on My spots. Off without NEXT_PUBLIC_TOKEN_MINT. */
export const TOKEN_SETUP = tokenSetup(process.env.NEXT_PUBLIC_TOKEN_MINT);
/** The shape of the next break, for the reserve bar. Off unless all four settings are given. */
export const BREAK_SHAPE = breakShapeSetup({
  paidSpots: process.env.NEXT_PUBLIC_BREAK_PAID_SPOTS,
  freeSpots: process.env.NEXT_PUBLIC_BREAK_FREE_SPOTS,
  spotPrice: process.env.NEXT_PUBLIC_BREAK_SPOT_PRICE,
  packs: process.env.NEXT_PUBLIC_BREAK_PACKS,
});
