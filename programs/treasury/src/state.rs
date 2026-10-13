use anchor_lang::prelude::*;

/// Singleton config at PDA `["config"]`. It is also the token authority of both bucket vaults.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Squads multisig vault. Changes the split and appoints the controller.
    pub admin: Pubkey,
    /// USDC mint the buckets are denominated in.
    pub usdc_mint: Pubkey,
    /// The only signer that may lock, unlock and pay out funds. In production this is the
    /// `breaks` program's treasury-authority PDA, so only that program's logic can move money.
    /// All zeros until the admin sets it.
    pub controller: Pubkey,
    /// Share of every deposit that goes to the `subsidy` bucket, in basis points.
    pub subsidy_bps: u16,
    /// Share of every deposit that goes to the `holder` bucket, in basis points.
    pub holder_bps: u16,
    /// Part of the subsidy vault reserved for breaks. Not available for new locks.
    pub locked_subsidy: u64,
    /// Part of the holder vault reserved for breaks. Not available for new locks.
    pub locked_holder: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Bucket {
    Subsidy,
    Holder,
}
