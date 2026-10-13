use anchor_lang::prelude::*;

/// Singleton config at PDA `["config"]`. It is also the token authority of both bucket vaults.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Squads multisig vault. The only signer allowed to change the split.
    pub admin: Pubkey,
    /// USDC mint the buckets are denominated in.
    pub usdc_mint: Pubkey,
    /// Share of every deposit that goes to the `subsidy` bucket, in basis points.
    pub subsidy_bps: u16,
    /// Share of every deposit that goes to the `holder` bucket, in basis points.
    pub holder_bps: u16,
    pub bump: u8,
}
