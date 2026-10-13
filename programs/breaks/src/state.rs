use anchor_lang::prelude::*;

/// Singleton config at PDA `["config"]`.
#[account]
#[derive(InitSpace)]
pub struct BreaksConfig {
    /// Squads multisig vault: pauses, cancels, appoints keeper and buyer.
    pub admin: Pubkey,
    /// Hot wallet that drives the break pipeline. Cannot move funds except along the state machine.
    pub keeper: Pubkey,
    /// Wallet that receives the pack budget and buys the packs (Collector Crypt). Capped per break.
    pub buyer: Pubkey,
    pub usdc_mint: Pubkey,
    pub next_break_id: u64,
    pub min_window_secs: i64,
    pub max_window_secs: i64,
    pub max_paid_spots: u16,
    pub max_free_spots: u16,
    pub paused: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum BreakStatus {
    /// Paid spots can be bought until `closes_at`.
    Open,
    /// Past the deadline; `spots_sold` is final.
    Closed,
    /// Eligible holders are committed on-chain.
    EligibilityCommitted,
    /// The pack budget was paid to the buyer wallet. No more refunds or cancel.
    Funded,
    /// The pulled cards are committed on-chain (hash of the pool).
    PoolCommitted,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct Break {
    pub id: u64,
    pub status: BreakStatus,
    /// Maximum number of paid spots.
    pub paid_spots: u16,
    pub free_spots: u16,
    pub spot_price: u64,
    pub max_pack_price: u64,
    /// Collector Crypt machine / price tier, committed at creation.
    pub pack_machine: [u8; 32],
    pub opens_at: i64,
    pub closes_at: i64,
    pub spots_sold: u16,
    /// Still locked in the treasury for this break.
    pub locked_subsidy: u64,
    pub locked_holder: u64,
    pub eligibility_root: [u8; 32],
    pub eligibility_total_weight: u64,
    pub eligibility_count: u32,
    pub eligibility_inputs_hash: [u8; 32],
    /// Packs to buy: sold paid spots plus drawn free spots. Set when funded.
    pub pool_size: u16,
    /// Most the buyer wallet may spend: `pool_size * max_pack_price`. Set when funded.
    pub pack_budget: u64,
    pub pool_hash: [u8; 32],
    pub bump: u8,
    pub escrow_bump: u8,
}

impl Break {
    pub fn require_status(&self, expected: BreakStatus) -> Result<()> {
        require!(self.status == expected, crate::errors::BreaksError::WrongStatus);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Spot {
    pub break_id: u64,
    pub index: u16,
    pub owner: Pubkey,
    pub paid: u64,
    pub refunded: bool,
    pub bump: u8,
}
