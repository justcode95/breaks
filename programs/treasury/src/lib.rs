use anchor_lang::prelude::*;

// Placeholder ID. Replace with `anchor keys sync` once the deploy keypair exists.
declare_id!("Bvq3U9fz2MiHkLH8u4zyt6T1bimxnaEuHkZhezNDT5R9");

#[program]
pub mod treasury {
    use super::*;

    /// Scaffold only. Real instructions are specified in CLAUDE.md and land in the phase for this program.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("treasury initialized: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
