use anchor_lang::prelude::*;

// Placeholder ID. Replace with `anchor keys sync` once the deploy keypair exists.
declare_id!("8tmJjCG3D4TF7oPiPWNoaCjZ4pN2U4H237BSGVw2B8KU");

#[program]
pub mod breaks {
    use super::*;

    /// Scaffold only. Real instructions are specified in CLAUDE.md and land in the phase for this program.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("breaks initialized: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
