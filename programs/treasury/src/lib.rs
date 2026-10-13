use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod errors;
pub mod math;
pub mod state;

use errors::TreasuryError;
use state::{Bucket, Config};

// Placeholder ID. Replace with `anchor keys sync` once the deploy keypair exists.
declare_id!("Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9");

pub const CONFIG_SEED: &[u8] = b"config";
pub const SUBSIDY_VAULT_SEED: &[u8] = b"subsidy_vault";
pub const HOLDER_VAULT_SEED: &[u8] = b"holder_vault";

/// Fee reserve. Creator fees (already swapped to USDC by the keeper) are deposited here and split
/// into two bucket vaults by the configured ratio:
/// - `subsidy`: tops up paid spots
/// - `holder`: pays for free holder spots
///
/// Money only leaves the buckets through the `controller` (the `breaks` program's treasury-authority
/// PDA): it first locks funds for a break, then either pays them out to the pack buyer or unlocks
/// what was not needed. Locked funds cannot be locked twice.
#[program]
pub mod treasury {
    use super::*;

    /// One-time setup. Only the program's upgrade authority (the Squads multisig) can call it, so
    /// nobody can front-run the deployment and install themselves as admin.
    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        math::validate_split(params.subsidy_bps, params.holder_bps)?;

        let config = &mut ctx.accounts.config;
        config.admin = params.admin;
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.subsidy_bps = params.subsidy_bps;
        config.holder_bps = params.holder_bps;
        config.controller = Pubkey::default();
        config.locked_subsidy = 0;
        config.locked_holder = 0;
        config.bump = ctx.bumps.config;

        emit!(Initialized {
            admin: config.admin,
            usdc_mint: config.usdc_mint,
            subsidy_bps: config.subsidy_bps,
            holder_bps: config.holder_bps,
        });
        Ok(())
    }

    /// Splits `amount` USDC from the depositor into the two buckets. Anyone may deposit; the keeper
    /// does it after each fee sweep.
    pub fn deposit_fees(ctx: Context<DepositFees>, amount: u64) -> Result<()> {
        require!(amount > 0, TreasuryError::ZeroAmount);
        let (to_subsidy, to_holder) = math::split(amount, ctx.accounts.config.subsidy_bps)?;

        let accounts = &ctx.accounts;
        for (vault, share) in [
            (&accounts.subsidy_vault, to_subsidy),
            (&accounts.holder_vault, to_holder),
        ] {
            if share == 0 {
                continue;
            }
            token::transfer(
                CpiContext::new(
                    accounts.token_program.key(),
                    Transfer {
                        from: accounts.depositor_usdc.to_account_info(),
                        to: vault.to_account_info(),
                        authority: accounts.depositor.to_account_info(),
                    },
                ),
                share,
            )?;
        }

        emit!(FeesDeposited {
            depositor: accounts.depositor.key(),
            amount,
            to_subsidy,
            to_holder,
        });
        Ok(())
    }

    /// Admin (multisig) only. Affects future deposits; balances already in the buckets stay put.
    pub fn set_split(ctx: Context<SetSplit>, subsidy_bps: u16, holder_bps: u16) -> Result<()> {
        math::validate_split(subsidy_bps, holder_bps)?;

        let config = &mut ctx.accounts.config;
        emit!(SplitChanged {
            admin: ctx.accounts.admin.key(),
            old_subsidy_bps: config.subsidy_bps,
            old_holder_bps: config.holder_bps,
            subsidy_bps,
            holder_bps,
        });
        config.subsidy_bps = subsidy_bps;
        config.holder_bps = holder_bps;
        Ok(())
    }

    /// Admin (multisig) only. Appoints the signer allowed to lock, unlock and pay out funds.
    pub fn set_controller(ctx: Context<SetController>, controller: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        emit!(ControllerChanged {
            admin: ctx.accounts.admin.key(),
            old_controller: config.controller,
            controller,
        });
        config.controller = controller;
        Ok(())
    }

    /// Controller only. Reserves funds for a break; fails if the bucket does not have that much
    /// unlocked. This is the on-chain funding rule: no break without covered costs.
    pub fn lock_funds(ctx: Context<ControllerCall>, subsidy: u64, holder: u64) -> Result<()> {
        let accounts = &mut *ctx.accounts;
        let config = &mut accounts.config;
        if subsidy > math::available(accounts.subsidy_vault.amount, config.locked_subsidy)? {
            return err!(TreasuryError::InsufficientAvailable);
        }
        if holder > math::available(accounts.holder_vault.amount, config.locked_holder)? {
            return err!(TreasuryError::InsufficientAvailable);
        }
        config.locked_subsidy = config
            .locked_subsidy
            .checked_add(subsidy)
            .ok_or(TreasuryError::MathOverflow)?;
        config.locked_holder = config
            .locked_holder
            .checked_add(holder)
            .ok_or(TreasuryError::MathOverflow)?;

        emit!(FundsLocked {
            subsidy,
            holder,
            locked_subsidy: config.locked_subsidy,
            locked_holder: config.locked_holder,
        });
        Ok(())
    }

    /// Controller only. Gives back locked funds that were not needed; they become available again.
    pub fn unlock_funds(ctx: Context<ControllerCall>, subsidy: u64, holder: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.locked_subsidy = config
            .locked_subsidy
            .checked_sub(subsidy)
            .ok_or(TreasuryError::InsufficientLocked)?;
        config.locked_holder = config
            .locked_holder
            .checked_sub(holder)
            .ok_or(TreasuryError::InsufficientLocked)?;

        emit!(FundsUnlocked {
            subsidy,
            holder,
            locked_subsidy: config.locked_subsidy,
            locked_holder: config.locked_holder,
        });
        Ok(())
    }

    /// Controller only. Pays out of locked funds only, so a payout can never touch money that is
    /// reserved for another break or still unlocked.
    pub fn pay_from_locked(ctx: Context<PayFromLocked>, bucket: Bucket, amount: u64) -> Result<()> {
        let accounts = &mut *ctx.accounts;
        let config = &mut accounts.config;
        let (locked, vault) = match bucket {
            Bucket::Subsidy => (&mut config.locked_subsidy, &accounts.subsidy_vault),
            Bucket::Holder => (&mut config.locked_holder, &accounts.holder_vault),
        };
        *locked = locked.checked_sub(amount).ok_or(TreasuryError::InsufficientLocked)?;
        let (locked_subsidy, locked_holder) = (config.locked_subsidy, config.locked_holder);

        let bump = [config.bump];
        let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &bump]];
        token::transfer(
            CpiContext::new_with_signer(
                accounts.token_program.key(),
                Transfer {
                    from: vault.to_account_info(),
                    to: accounts.destination.to_account_info(),
                    authority: config.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        emit!(FundsPaid {
            bucket,
            amount,
            destination: accounts.destination.key(),
            locked_subsidy,
            locked_holder,
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    /// Squads multisig vault that will control the split.
    pub admin: Pubkey,
    pub subsidy_bps: u16,
    pub holder_bps: u16,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Must be the program's upgrade authority. Pays rent for the new accounts.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ TreasuryError::InvalidProgramData)]
    pub program: Program<'info, crate::program::Treasury>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ TreasuryError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init, payer = authority, seeds = [SUBSIDY_VAULT_SEED], bump,
        token::mint = usdc_mint, token::authority = config,
    )]
    pub subsidy_vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = authority, seeds = [HOLDER_VAULT_SEED], bump,
        token::mint = usdc_mint, token::authority = config,
    )]
    pub holder_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositFees<'info> {
    pub depositor: Signer<'info>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = depositor)]
    pub depositor_usdc: Account<'info, TokenAccount>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [SUBSIDY_VAULT_SEED], bump)]
    pub subsidy_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [HOLDER_VAULT_SEED], bump)]
    pub holder_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetSplit<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ TreasuryError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetController<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ TreasuryError::Unauthorized)]
    pub config: Account<'info, Config>,
}

/// Used by `lock_funds` and `unlock_funds`.
#[derive(Accounts)]
pub struct ControllerCall<'info> {
    pub controller: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = controller @ TreasuryError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(seeds = [SUBSIDY_VAULT_SEED], bump)]
    pub subsidy_vault: Account<'info, TokenAccount>,
    #[account(seeds = [HOLDER_VAULT_SEED], bump)]
    pub holder_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct PayFromLocked<'info> {
    pub controller: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = controller @ TreasuryError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [SUBSIDY_VAULT_SEED], bump)]
    pub subsidy_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [HOLDER_VAULT_SEED], bump)]
    pub holder_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.usdc_mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct Initialized {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub subsidy_bps: u16,
    pub holder_bps: u16,
}

#[event]
pub struct FeesDeposited {
    pub depositor: Pubkey,
    pub amount: u64,
    pub to_subsidy: u64,
    pub to_holder: u64,
}

#[event]
pub struct SplitChanged {
    pub admin: Pubkey,
    pub old_subsidy_bps: u16,
    pub old_holder_bps: u16,
    pub subsidy_bps: u16,
    pub holder_bps: u16,
}

#[event]
pub struct ControllerChanged {
    pub admin: Pubkey,
    pub old_controller: Pubkey,
    pub controller: Pubkey,
}

#[event]
pub struct FundsLocked {
    pub subsidy: u64,
    pub holder: u64,
    pub locked_subsidy: u64,
    pub locked_holder: u64,
}

#[event]
pub struct FundsUnlocked {
    pub subsidy: u64,
    pub holder: u64,
    pub locked_subsidy: u64,
    pub locked_holder: u64,
}

#[event]
pub struct FundsPaid {
    pub bucket: Bucket,
    pub amount: u64,
    pub destination: Pubkey,
    pub locked_subsidy: u64,
    pub locked_holder: u64,
}
