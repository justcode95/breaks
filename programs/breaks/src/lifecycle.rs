use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use treasury::state::Bucket;

use crate::{
    errors::BreaksError,
    math,
    state::{Break, BreakStatus, BreaksConfig, Spot},
    treasury_cpi::TreasuryCtx,
    BREAK_SEED, CONFIG_SEED, ESCROW_SEED, SPOT_SEED, TREASURY_AUTHORITY_SEED,
};

// ---------------------------------------------------------------- create_break

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateBreakParams {
    /// Maximum number of paid spots.
    pub paid_spots: u16,
    pub free_spots: u16,
    pub spot_price: u64,
    pub max_pack_price: u64,
    pub pack_machine: [u8; 32],
    pub opens_at: i64,
    pub closes_at: i64,
}

#[derive(Accounts)]
pub struct CreateBreak<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper @ BreaksError::Unauthorized)]
    pub config: Account<'info, BreaksConfig>,
    #[account(
        init, payer = keeper, space = 8 + Break::INIT_SPACE,
        seeds = [BREAK_SEED, &config.next_break_id.to_le_bytes()], bump,
    )]
    pub break_: Account<'info, Break>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    /// Holds the buyers' USDC until the break is funded or cancelled.
    #[account(
        init, payer = keeper, seeds = [ESCROW_SEED, break_.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = break_,
    )]
    pub escrow: Account<'info, TokenAccount>,
    /// CHECK: PDA of this program; it is the treasury's controller and only ever signs CPIs.
    #[account(seeds = [TREASURY_AUTHORITY_SEED], bump)]
    pub treasury_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [treasury::CONFIG_SEED], bump = treasury_config.bump, seeds::program = treasury::ID)]
    pub treasury_config: Account<'info, treasury::state::Config>,
    #[account(seeds = [treasury::SUBSIDY_VAULT_SEED], bump, seeds::program = treasury::ID)]
    pub subsidy_vault: Account<'info, TokenAccount>,
    #[account(seeds = [treasury::HOLDER_VAULT_SEED], bump, seeds::program = treasury::ID)]
    pub holder_vault: Account<'info, TokenAccount>,
    pub treasury_program: Program<'info, treasury::program::Treasury>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> CreateBreak<'info> {
    pub fn handle(&mut self, p: CreateBreakParams, bumps: &CreateBreakBumps) -> Result<()> {
        let config = &mut self.config;
        require!(!config.paused, BreaksError::Paused);
        require!(
            p.paid_spots >= 1 && p.paid_spots <= config.max_paid_spots && p.free_spots <= config.max_free_spots,
            BreaksError::InvalidSpotCounts
        );
        require!(p.spot_price > 0 && p.max_pack_price > 0, BreaksError::InvalidPrice);

        let now = Clock::get()?.unix_timestamp;
        let window = p.closes_at.checked_sub(p.opens_at).ok_or(BreaksError::InvalidWindow)?;
        require!(
            p.closes_at > now && window >= config.min_window_secs && window <= config.max_window_secs,
            BreaksError::InvalidWindow
        );

        let (lock_subsidy, lock_holder) =
            math::creation_locks(p.paid_spots, p.free_spots, p.spot_price, p.max_pack_price)?;

        let id = config.next_break_id;
        config.next_break_id = id.checked_add(1).ok_or(BreaksError::MathOverflow)?;

        let b = &mut self.break_;
        b.id = id;
        b.status = BreakStatus::Open;
        b.paid_spots = p.paid_spots;
        b.free_spots = p.free_spots;
        b.spot_price = p.spot_price;
        b.max_pack_price = p.max_pack_price;
        b.pack_machine = p.pack_machine;
        b.opens_at = p.opens_at;
        b.closes_at = p.closes_at;
        b.spots_sold = 0;
        b.locked_subsidy = lock_subsidy;
        b.locked_holder = lock_holder;
        b.eligibility_root = [0; 32];
        b.eligibility_total_weight = 0;
        b.eligibility_count = 0;
        b.eligibility_inputs_hash = [0; 32];
        b.pool_size = 0;
        b.pack_budget = 0;
        b.pool_hash = [0; 32];
        b.randomness_attempt = 0;
        b.randomness_request_id = [0; 32];
        b.randomness_requested_at = 0;
        b.seed = [0; 32];
        b.seeded_at = 0;
        b.bump = bumps.break_;
        b.escrow_bump = bumps.escrow;

        // The funding rule: the treasury refuses unless both buckets can cover the worst case.
        TreasuryCtx {
            program: &self.treasury_program,
            authority: &self.treasury_authority,
            authority_bump: bumps.treasury_authority,
            config: &self.treasury_config,
            subsidy_vault: &self.subsidy_vault,
            holder_vault: &self.holder_vault,
        }
        .lock(lock_subsidy, lock_holder)?;

        emit!(BreakCreated {
            id,
            paid_spots: p.paid_spots,
            free_spots: p.free_spots,
            spot_price: p.spot_price,
            max_pack_price: p.max_pack_price,
            pack_machine: p.pack_machine,
            opens_at: p.opens_at,
            closes_at: p.closes_at,
            locked_subsidy: lock_subsidy,
            locked_holder: lock_holder,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- buy_spot

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct BuySpot<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, BreaksConfig>,
    #[account(mut, seeds = [BREAK_SEED, &break_.id.to_le_bytes()], bump = break_.bump)]
    pub break_: Account<'info, Break>,
    #[account(mut, seeds = [ESCROW_SEED, break_.key().as_ref()], bump = break_.escrow_bump)]
    pub escrow: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Account<'info, TokenAccount>,
    #[account(
        init, payer = buyer, space = 8 + Spot::INIT_SPACE,
        seeds = [SPOT_SEED, break_.key().as_ref(), &index.to_le_bytes()], bump,
    )]
    pub spot: Account<'info, Spot>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> BuySpot<'info> {
    pub fn handle(&mut self, index: u16, bumps: &BuySpotBumps) -> Result<()> {
        require!(!self.config.paused, BreaksError::Paused);
        let b = &mut self.break_;
        b.require_status(BreakStatus::Open)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= b.opens_at && now < b.closes_at, BreaksError::NotInSaleWindow);
        require!(b.spots_sold < b.paid_spots, BreaksError::SoldOut);
        require!(index == b.spots_sold, BreaksError::WrongSpotIndex);

        b.spots_sold += 1;
        let (break_id, price) = (b.id, b.spot_price);

        let spot = &mut self.spot;
        spot.break_id = break_id;
        spot.index = index;
        spot.owner = self.buyer.key();
        spot.paid = price;
        spot.refunded = false;
        spot.bump = bumps.spot;

        token::transfer(
            CpiContext::new(
                self.token_program.key(),
                Transfer {
                    from: self.buyer_usdc.to_account_info(),
                    to: self.escrow.to_account_info(),
                    authority: self.buyer.to_account_info(),
                },
            ),
            price,
        )?;

        emit!(SpotBought {
            break_id,
            index,
            owner: self.buyer.key(),
            paid: price
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- close_break

#[derive(Accounts)]
pub struct CloseBreak<'info> {
    #[account(mut, seeds = [BREAK_SEED, &break_.id.to_le_bytes()], bump = break_.bump)]
    pub break_: Account<'info, Break>,
}

impl CloseBreak<'_> {
    /// Anyone may close a break once its deadline has passed.
    pub fn handle(&mut self) -> Result<()> {
        let b = &mut self.break_;
        b.require_status(BreakStatus::Open)?;
        require!(
            Clock::get()?.unix_timestamp >= b.closes_at,
            BreaksError::TooEarlyToClose
        );
        b.status = BreakStatus::Closed;
        emit!(BreakClosed {
            id: b.id,
            spots_sold: b.spots_sold
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- commit_eligibility

#[derive(Accounts)]
pub struct KeeperBreakCall<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper @ BreaksError::Unauthorized)]
    pub config: Account<'info, BreaksConfig>,
    #[account(mut, seeds = [BREAK_SEED, &break_.id.to_le_bytes()], bump = break_.bump)]
    pub break_: Account<'info, Break>,
}

impl KeeperBreakCall<'_> {
    pub fn commit_eligibility(
        &mut self,
        root: [u8; 32],
        total_weight: u64,
        entry_count: u32,
        inputs_hash: [u8; 32],
    ) -> Result<()> {
        let b = &mut self.break_;
        b.require_status(BreakStatus::Closed)?;
        require!(
            (total_weight == 0) == (entry_count == 0),
            BreaksError::InvalidEligibility
        );

        b.eligibility_root = root;
        b.eligibility_total_weight = total_weight;
        b.eligibility_count = entry_count;
        b.eligibility_inputs_hash = inputs_hash;
        b.status = BreakStatus::EligibilityCommitted;

        emit!(EligibilityCommitted {
            id: b.id,
            root,
            total_weight,
            entry_count,
            inputs_hash
        });
        Ok(())
    }

    pub fn commit_pool(&mut self, pool_hash: [u8; 32], pool_size: u16) -> Result<()> {
        let b = &mut self.break_;
        b.require_status(BreakStatus::Funded)?;
        require!(pool_size == b.pool_size, BreaksError::PoolSizeMismatch);

        b.pool_hash = pool_hash;
        b.status = BreakStatus::PoolCommitted;

        emit!(PoolCommitted {
            id: b.id,
            pool_hash,
            pool_size
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- fund_purchases

#[derive(Accounts)]
pub struct FundPurchases<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper @ BreaksError::Unauthorized)]
    pub config: Account<'info, BreaksConfig>,
    #[account(mut, seeds = [BREAK_SEED, &break_.id.to_le_bytes()], bump = break_.bump)]
    pub break_: Account<'info, Break>,
    #[account(mut, seeds = [ESCROW_SEED, break_.key().as_ref()], bump = break_.escrow_bump)]
    pub escrow: Account<'info, TokenAccount>,
    /// The buyer wallet's USDC account: the only place the pack budget can go.
    #[account(mut, token::mint = config.usdc_mint, token::authority = config.buyer)]
    pub buyer_usdc: Account<'info, TokenAccount>,
    /// CHECK: PDA of this program; it is the treasury's controller and only ever signs CPIs.
    #[account(seeds = [TREASURY_AUTHORITY_SEED], bump)]
    pub treasury_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [treasury::CONFIG_SEED], bump = treasury_config.bump, seeds::program = treasury::ID)]
    pub treasury_config: Account<'info, treasury::state::Config>,
    #[account(mut, seeds = [treasury::SUBSIDY_VAULT_SEED], bump, seeds::program = treasury::ID)]
    pub subsidy_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [treasury::HOLDER_VAULT_SEED], bump, seeds::program = treasury::ID)]
    pub holder_vault: Account<'info, TokenAccount>,
    pub treasury_program: Program<'info, treasury::program::Treasury>,
    pub token_program: Program<'info, Token>,
}

impl<'info> FundPurchases<'info> {
    /// Pays for the packs: the buyers' USDC from escrow, the subsidy top-up and the free-spot
    /// packs from the locked treasury funds. Locks that are not needed are returned.
    pub fn handle(&mut self, bumps: &FundPurchasesBumps) -> Result<()> {
        // Money leaving for the buyer wallet is the one step a pause must be able to stop.
        require!(!self.config.paused, BreaksError::Paused);
        let b = &mut self.break_;
        b.require_status(BreakStatus::EligibilityCommitted)?;
        let f = math::funding(
            b.spots_sold,
            b.free_spots,
            b.eligibility_count,
            b.spot_price,
            b.max_pack_price,
            b.locked_subsidy,
            b.locked_holder,
        )?;

        b.pool_size = f.pool_size;
        b.pack_budget = f.pack_budget;
        b.locked_subsidy = 0;
        b.locked_holder = 0;
        b.status = BreakStatus::Funded;
        let (id, id_bytes, bump) = (b.id, b.id.to_le_bytes(), [b.bump]);

        let treasury = TreasuryCtx {
            program: &self.treasury_program,
            authority: &self.treasury_authority,
            authority_bump: bumps.treasury_authority,
            config: &self.treasury_config,
            subsidy_vault: &self.subsidy_vault,
            holder_vault: &self.holder_vault,
        };
        treasury.unlock(f.unlock_subsidy, f.unlock_holder)?;
        treasury.pay(
            Bucket::Subsidy,
            f.from_subsidy,
            &self.buyer_usdc,
            self.token_program.to_account_info(),
        )?;
        treasury.pay(
            Bucket::Holder,
            f.from_holder,
            &self.buyer_usdc,
            self.token_program.to_account_info(),
        )?;

        if f.from_escrow > 0 {
            let seeds: &[&[&[u8]]] = &[&[BREAK_SEED, &id_bytes, &bump]];
            token::transfer(
                CpiContext::new_with_signer(
                    self.token_program.key(),
                    Transfer {
                        from: self.escrow.to_account_info(),
                        to: self.buyer_usdc.to_account_info(),
                        authority: self.break_.to_account_info(),
                    },
                    seeds,
                ),
                f.from_escrow,
            )?;
        }

        emit!(PurchasesFunded {
            id,
            pool_size: f.pool_size,
            pack_budget: f.pack_budget,
            from_escrow: f.from_escrow,
            from_subsidy: f.from_subsidy,
            from_holder: f.from_holder,
            unlocked_subsidy: f.unlock_subsidy,
            unlocked_holder: f.unlock_holder,
        });
        Ok(())
    }
}

#[event]
pub struct BreakCreated {
    pub id: u64,
    pub paid_spots: u16,
    pub free_spots: u16,
    pub spot_price: u64,
    pub max_pack_price: u64,
    pub pack_machine: [u8; 32],
    pub opens_at: i64,
    pub closes_at: i64,
    pub locked_subsidy: u64,
    pub locked_holder: u64,
}

#[event]
pub struct SpotBought {
    pub break_id: u64,
    pub index: u16,
    pub owner: Pubkey,
    pub paid: u64,
}

#[event]
pub struct BreakClosed {
    pub id: u64,
    pub spots_sold: u16,
}

#[event]
pub struct EligibilityCommitted {
    pub id: u64,
    pub root: [u8; 32],
    pub total_weight: u64,
    pub entry_count: u32,
    pub inputs_hash: [u8; 32],
}

#[event]
pub struct PurchasesFunded {
    pub id: u64,
    pub pool_size: u16,
    pub pack_budget: u64,
    pub from_escrow: u64,
    pub from_subsidy: u64,
    pub from_holder: u64,
    pub unlocked_subsidy: u64,
    pub unlocked_holder: u64,
}

#[event]
pub struct PoolCommitted {
    pub id: u64,
    pub pool_hash: [u8; 32],
    pub pool_size: u16,
}
