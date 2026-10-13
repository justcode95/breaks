use anchor_lang::prelude::*;

#[error_code]
pub enum TreasuryError {
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Program data account does not belong to this program")]
    InvalidProgramData,
    #[msg("Subsidy and holder shares must add up to 10000 basis points")]
    InvalidSplit,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
