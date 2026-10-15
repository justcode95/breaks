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
    /// Adapter program that produces randomness (see `randomness.rs`). Appointed by the admin so
    /// a vendor can be replaced without touching this program.
    pub randomness_program: Pubkey,
    /// How long a randomness request may stay unanswered before it can be repeated.
    pub randomness_timeout_secs: i64,
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
    /// Randomness was requested from the adapter and has not been settled yet.
    RandomnessRequested,
    /// The seed is final. The free-spot winners are claimed one by one with a proof.
    Settled,
    /// Every free-spot winner is recorded (or there were none). The cards can be assigned and delivered.
    Drawn,
    Cancelled,
}

/// Most free spots a break can have (also the capacity of the winner list).
pub const MAX_FREE_SPOTS: usize = 16;

/// Most packs (so most spots, paid and free together) a break can have.
pub const MAX_PACKS: usize = 64;

/// Most different pack tiers (a Collector Crypt machine and the most a pack from it may cost) one break can list.
pub const MAX_TIERS: usize = 8;

/// A Collector Crypt machine / price tier, committed at creation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub struct PackTier {
    pub machine: [u8; 32],
    /// The most one pack from this machine may cost (USDC base units). The buyer wallet is funded with exactly this.
    pub max_price: u64,
}

/// A recorded free-spot winner: the wallet and the weight range that was drawn.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct FreeWinner {
    pub wallet: Pubkey,
    pub start: u64,
    pub weight: u64,
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
    /// How many of `tiers` are used.
    pub tier_count: u8,
    /// The machines the packs of this break come from, committed at creation.
    pub tiers: [PackTier; MAX_TIERS],
    /// The tier of each pack, in the order the packs are included: cheapest first, so a break that does not
    /// fill drops the most expensive packs. Only the first `paid_spots + free_spots` entries are used.
    pub packs: [u8; MAX_PACKS],
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
    /// Most the buyer wallet may spend: the prices of the first `pool_size` packs added up. Set when funded.
    pub pack_budget: u64,
    pub pool_hash: [u8; 32],
    /// Number of the current randomness request (0 for the first).
    pub randomness_attempt: u8,
    pub randomness_request_id: [u8; 32],
    pub randomness_requested_at: i64,
    /// The seed of the draw: what the adapter's VRF produced for the settled request.
    pub seed: [u8; 32],
    pub seeded_at: i64,
    /// How many free-spot winners have been claimed so far (they are claimed in order).
    pub free_winner_count: u8,
    pub free_winners: [FreeWinner; MAX_FREE_SPOTS],
    pub bump: u8,
    pub escrow_bump: u8,
}

impl Break {
    /// Packs in the full break: one per spot.
    pub fn pack_count(&self) -> usize {
        usize::from(self.paid_spots) + usize::from(self.free_spots)
    }

    /// The most each pack may cost, in the order the packs are included.
    pub fn pack_prices(&self) -> Vec<u64> {
        crate::packs::prices(
            &self.tiers[..usize::from(self.tier_count)],
            &self.packs[..self.pack_count()],
        )
    }

    /// Free-spot winners this break will have: the pool minus the paid spots.
    pub fn free_winners_expected(&self) -> u16 {
        self.pool_size - self.spots_sold
    }
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
