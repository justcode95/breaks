// The site's chain settings, from the environment the site was built with. The `NEXT_PUBLIC_` values have to be written
// out like this for the build to put them into the page.

import { chainSetup } from "./config";

export const SETUP = chainSetup({ rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL, program: process.env.NEXT_PUBLIC_BREAKS_PROGRAM_ID });
