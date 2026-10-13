//! Calls into the treasury program. The `breaks` program is the treasury's controller: its
//! `treasury_authority` PDA signs these calls, so no one else can lock, unlock or pay out funds.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use treasury::state::{Bucket, Config as TreasuryConfig};

use crate::TREASURY_AUTHORITY_SEED;

pub struct TreasuryCtx<'a, 'info> {
    pub program: &'a Program<'info, treasury::program::Treasury>,
    pub authority: &'a UncheckedAccount<'info>,
    pub authority_bump: u8,
    pub config: &'a Account<'info, TreasuryConfig>,
    pub subsidy_vault: &'a Account<'info, TokenAccount>,
    pub holder_vault: &'a Account<'info, TokenAccount>,
}

impl<'a, 'info> TreasuryCtx<'a, 'info> {
    fn controller_call(&self) -> treasury::cpi::accounts::ControllerCall<'info> {
        treasury::cpi::accounts::ControllerCall {
            controller: self.authority.to_account_info(),
            config: self.config.to_account_info(),
            subsidy_vault: self.subsidy_vault.to_account_info(),
            holder_vault: self.holder_vault.to_account_info(),
        }
    }

    /// Reserves funds for a break; the treasury refuses if a bucket cannot cover it.
    pub fn lock(&self, subsidy: u64, holder: u64) -> Result<()> {
        let bump = [self.authority_bump];
        let seeds: &[&[&[u8]]] = &[&[TREASURY_AUTHORITY_SEED, &bump]];
        let ctx = CpiContext::new_with_signer(self.program.key(), self.controller_call(), seeds);
        treasury::cpi::lock_funds(ctx, subsidy, holder)
    }

    /// Gives back locked funds that were not needed.
    pub fn unlock(&self, subsidy: u64, holder: u64) -> Result<()> {
        if subsidy == 0 && holder == 0 {
            return Ok(());
        }
        let bump = [self.authority_bump];
        let seeds: &[&[&[u8]]] = &[&[TREASURY_AUTHORITY_SEED, &bump]];
        let ctx = CpiContext::new_with_signer(self.program.key(), self.controller_call(), seeds);
        treasury::cpi::unlock_funds(ctx, subsidy, holder)
    }

    /// Pays locked funds out to `destination` (a USDC token account).
    pub fn pay(
        &self,
        bucket: Bucket,
        amount: u64,
        destination: &Account<'info, TokenAccount>,
        token_program: AccountInfo<'info>,
    ) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let bump = [self.authority_bump];
        let seeds: &[&[&[u8]]] = &[&[TREASURY_AUTHORITY_SEED, &bump]];
        let accounts = treasury::cpi::accounts::PayFromLocked {
            controller: self.authority.to_account_info(),
            config: self.config.to_account_info(),
            subsidy_vault: self.subsidy_vault.to_account_info(),
            holder_vault: self.holder_vault.to_account_info(),
            destination: destination.to_account_info(),
            token_program,
        };
        let ctx = CpiContext::new_with_signer(self.program.key(), accounts, seeds);
        treasury::cpi::pay_from_locked(ctx, bucket, amount)
    }
}
