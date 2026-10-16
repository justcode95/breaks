use anchor_lang::prelude::*;

pub mod admin;
pub mod cancel;
pub mod claims;
pub mod draw;
pub mod errors;
pub mod lifecycle;
pub mod math;
pub mod packs;
pub mod randomness;
pub mod state;
pub mod treasury_cpi;

pub use admin::*;
pub use cancel::*;
pub use claims::*;
pub use draw::*;
pub use lifecycle::*;

// Placeholder ID. Replace with `anchor keys sync` once the deploy keypair exists.
declare_id!("8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU");

pub const CONFIG_SEED: &[u8] = b"config";
pub const BREAK_SEED: &[u8] = b"break";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const SPOT_SEED: &[u8] = b"spot";
/// PDA that signs as the treasury's controller.
pub const TREASURY_AUTHORITY_SEED: &[u8] = b"treasury_authority";

/// The break pipeline up to the pack purchase: create (locks funds in the treasury), sell paid
/// spots into escrow, close at the deadline, commit who is eligible for the free spots, pay the
/// pack budget to the buyer wallet, commit the pulled pool. Randomness and free-spot claims follow
/// in the next step. A break can be cancelled (full refunds) until the pack budget is paid.
#[program]
pub mod breaks {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        ctx.accounts.handle(params, &ctx.bumps)
    }

    /// Admin only.
    pub fn set_keeper(ctx: Context<AdminOnly>, keeper: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        emit!(KeeperChanged {
            old_keeper: config.keeper,
            keeper
        });
        config.keeper = keeper;
        Ok(())
    }

    /// Admin only. The wallet that receives the pack budget.
    pub fn set_buyer(ctx: Context<AdminOnly>, buyer: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        emit!(BuyerChanged {
            old_buyer: config.buyer,
            buyer
        });
        config.buyer = buyer;
        Ok(())
    }

    /// Admin only. Pausing stops new breaks and new spots; refunds and cancels keep working.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PausedChanged { paused });
        Ok(())
    }

    /// Admin only. Appoints the randomness adapter program (see `randomness.rs`).
    pub fn set_randomness(ctx: Context<AdminOnly>, program: Pubkey, timeout_secs: i64) -> Result<()> {
        require!(timeout_secs > 0, errors::BreaksError::InvalidRandomnessConfig);
        let config = &mut ctx.accounts.config;
        emit!(RandomnessChanged {
            old_program: config.randomness_program,
            program,
            timeout_secs
        });
        config.randomness_program = program;
        config.randomness_timeout_secs = timeout_secs;
        Ok(())
    }

    /// Keeper only.
    pub fn create_break(ctx: Context<CreateBreak>, params: CreateBreakParams) -> Result<()> {
        ctx.accounts.handle(params, &ctx.bumps)
    }

    pub fn buy_spot(ctx: Context<BuySpot>, index: u16) -> Result<()> {
        ctx.accounts.handle(index, &ctx.bumps)
    }

    /// Anyone, once `closes_at` has passed.
    pub fn close_break(ctx: Context<CloseBreak>) -> Result<()> {
        ctx.accounts.handle()
    }

    /// Keeper only.
    pub fn commit_eligibility(
        ctx: Context<KeeperBreakCall>,
        root: [u8; 32],
        total_weight: u64,
        entry_count: u32,
        inputs_hash: [u8; 32],
    ) -> Result<()> {
        ctx.accounts
            .commit_eligibility(root, total_weight, entry_count, inputs_hash)
    }

    /// Keeper only. Pays the pack budget to the buyer wallet.
    pub fn fund_purchases(ctx: Context<FundPurchases>) -> Result<()> {
        ctx.accounts.handle(&ctx.bumps)
    }

    /// Keeper only.
    pub fn commit_pool(ctx: Context<KeeperBreakCall>, pool_hash: [u8; 32], pool_size: u16) -> Result<()> {
        ctx.accounts.commit_pool(pool_hash, pool_size)
    }

    /// Keeper only, once the eligibility root and the pool are committed. Repeats the request if
    /// the adapter never answered within the configured timeout.
    pub fn request_randomness<'info>(ctx: Context<'info, RequestRandomness<'info>>) -> Result<()> {
        ctx.accounts.handle(ctx.remaining_accounts)
    }

    /// Anyone, once the adapter has produced the randomness.
    pub fn settle_randomness(ctx: Context<SettleRandomness>) -> Result<()> {
        ctx.accounts.handle()
    }

    /// Anyone, once the seed is final. Records the next free-spot winner; the proof must lead to the
    /// committed eligibility root and the wallet must be the one the draw picks. In order.
    pub fn claim_free_spot(
        ctx: Context<ClaimFreeSpot>,
        index: u8,
        wallet: Pubkey,
        weight: u64,
        proof: Vec<ProofStepArg>,
    ) -> Result<()> {
        ctx.accounts.handle(index, wallet, weight, proof)
    }

    /// Admin only, before `fund_purchases`.
    pub fn cancel_break(ctx: Context<CancelBreak>) -> Result<()> {
        ctx.accounts.handle(&ctx.bumps)
    }

    /// Anyone, once the eligibility list is committed, and only for a break that `fund_purchases` can never pay for.
    pub fn cancel_unfundable(ctx: Context<CancelUnfundable>) -> Result<()> {
        ctx.accounts.handle(&ctx.bumps)
    }

    /// Anyone; the money goes to the spot's owner.
    pub fn refund_spot(ctx: Context<RefundSpot>) -> Result<()> {
        ctx.accounts.handle()
    }
}
