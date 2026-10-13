use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    errors::BreaksError,
    state::{Break, BreakStatus, BreaksConfig, Spot},
    treasury_cpi::TreasuryCtx,
    BREAK_SEED, CONFIG_SEED, ESCROW_SEED, SPOT_SEED, TREASURY_AUTHORITY_SEED,
};

#[derive(Accounts)]
pub struct CancelBreak<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BreaksError::Unauthorized)]
    pub config: Account<'info, BreaksConfig>,
    #[account(mut, seeds = [BREAK_SEED, &break_.id.to_le_bytes()], bump = break_.bump)]
    pub break_: Account<'info, Break>,
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
}

impl CancelBreak<'_> {
    /// Admin only, and only before the pack budget is paid out. Buyers then take their money back
    /// with `refund_spot`; the locked treasury funds are released immediately.
    pub fn handle(&mut self, bumps: &CancelBreakBumps) -> Result<()> {
        let b = &mut self.break_;
        require!(
            matches!(
                b.status,
                BreakStatus::Open | BreakStatus::Closed | BreakStatus::EligibilityCommitted
            ),
            BreaksError::WrongStatus
        );
        let (locked_subsidy, locked_holder) = (b.locked_subsidy, b.locked_holder);
        b.locked_subsidy = 0;
        b.locked_holder = 0;
        b.status = BreakStatus::Cancelled;

        TreasuryCtx {
            program: &self.treasury_program,
            authority: &self.treasury_authority,
            authority_bump: bumps.treasury_authority,
            config: &self.treasury_config,
            subsidy_vault: &self.subsidy_vault,
            holder_vault: &self.holder_vault,
        }
        .unlock(locked_subsidy, locked_holder)?;

        emit!(BreakCancelled {
            id: b.id,
            spots_sold: b.spots_sold
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RefundSpot<'info> {
    #[account(seeds = [BREAK_SEED, &break_.id.to_le_bytes()], bump = break_.bump)]
    pub break_: Account<'info, Break>,
    #[account(mut, seeds = [ESCROW_SEED, break_.key().as_ref()], bump = break_.escrow_bump)]
    pub escrow: Account<'info, TokenAccount>,
    #[account(
        mut, seeds = [SPOT_SEED, break_.key().as_ref(), &spot.index.to_le_bytes()], bump = spot.bump,
    )]
    pub spot: Account<'info, Spot>,
    /// Must belong to the spot's owner, so anyone can trigger a refund but only the owner receives it.
    #[account(mut, token::mint = escrow.mint, token::authority = spot.owner)]
    pub owner_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

impl RefundSpot<'_> {
    pub fn handle(&mut self) -> Result<()> {
        self.break_.require_status(BreakStatus::Cancelled)?;
        require!(!self.spot.refunded, BreaksError::AlreadyRefunded);
        self.spot.refunded = true;
        let (id_bytes, bump) = (self.break_.id.to_le_bytes(), [self.break_.bump]);
        let (amount, index) = (self.spot.paid, self.spot.index);

        let seeds: &[&[&[u8]]] = &[&[BREAK_SEED, &id_bytes, &bump]];
        token::transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer {
                    from: self.escrow.to_account_info(),
                    to: self.owner_usdc.to_account_info(),
                    authority: self.break_.to_account_info(),
                },
                seeds,
            ),
            amount,
        )?;

        emit!(SpotRefunded {
            break_id: self.break_.id,
            index,
            owner: self.spot.owner,
            amount
        });
        Ok(())
    }
}

#[event]
pub struct BreakCancelled {
    pub id: u64,
    pub spots_sold: u16,
}

#[event]
pub struct SpotRefunded {
    pub break_id: u64,
    pub index: u16,
    pub owner: Pubkey,
    pub amount: u64,
}
