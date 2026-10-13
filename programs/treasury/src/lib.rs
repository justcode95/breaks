use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod errors;
pub mod math;
pub mod state;

use errors::TreasuryError;
use state::Config;

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
/// Moving money out of the buckets (locking for a break, funding the pack buyer) is part of the
/// `breaks` program and is added together with it in Phase 3.
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
