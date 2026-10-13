use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{errors::BreaksError, state::BreaksConfig, CONFIG_SEED};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    /// Squads multisig vault.
    pub admin: Pubkey,
    /// Hot wallet that drives the pipeline.
    pub keeper: Pubkey,
    /// Wallet that receives the pack budget.
    pub buyer: Pubkey,
    pub min_window_secs: i64,
    pub max_window_secs: i64,
    pub max_paid_spots: u16,
    pub max_free_spots: u16,
    /// Randomness adapter program.
    pub randomness_program: Pubkey,
    pub randomness_timeout_secs: i64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Must be the program's upgrade authority. Pays rent for the config.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ BreaksError::InvalidProgramData)]
    pub program: Program<'info, crate::program::Breaks>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ BreaksError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = authority, space = 8 + BreaksConfig::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, BreaksConfig>,
    /// The treasury this program will lock funds in. Its mint becomes ours.
    #[account(seeds = [treasury::CONFIG_SEED], bump = treasury_config.bump, seeds::program = treasury::ID)]
    pub treasury_config: Account<'info, treasury::state::Config>,
    #[account(address = treasury_config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

impl Initialize<'_> {
    pub fn handle(&mut self, p: InitializeParams, bumps: &InitializeBumps) -> Result<()> {
        require!(
            p.min_window_secs > 0 && p.min_window_secs <= p.max_window_secs,
            BreaksError::InvalidLimits
        );
        require!(p.max_paid_spots >= 1, BreaksError::InvalidLimits);
        require!(p.randomness_timeout_secs > 0, BreaksError::InvalidRandomnessConfig);

        let config = &mut self.config;
        config.admin = p.admin;
        config.keeper = p.keeper;
        config.buyer = p.buyer;
        config.usdc_mint = self.usdc_mint.key();
        config.randomness_program = p.randomness_program;
        config.randomness_timeout_secs = p.randomness_timeout_secs;
        config.next_break_id = 0;
        config.min_window_secs = p.min_window_secs;
        config.max_window_secs = p.max_window_secs;
        config.max_paid_spots = p.max_paid_spots;
        config.max_free_spots = p.max_free_spots;
        config.paused = false;
        config.bump = bumps.config;

        emit!(Initialized {
            admin: p.admin,
            keeper: p.keeper,
            buyer: p.buyer
        });
        Ok(())
    }
}

/// Used by `set_keeper`, `set_buyer` and `set_paused`.
#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BreaksError::Unauthorized)]
    pub config: Account<'info, BreaksConfig>,
}

#[event]
pub struct Initialized {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub buyer: Pubkey,
}

#[event]
pub struct KeeperChanged {
    pub old_keeper: Pubkey,
    pub keeper: Pubkey,
}

#[event]
pub struct BuyerChanged {
    pub old_buyer: Pubkey,
    pub buyer: Pubkey,
}

#[event]
pub struct RandomnessChanged {
    pub old_program: Pubkey,
    pub program: Pubkey,
    pub timeout_secs: i64,
}

#[event]
pub struct PausedChanged {
    pub paused: bool,
}
