use anchor_lang::prelude::*;

#[error_code]
pub enum BreaksError {
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Program data account does not belong to this program")]
    InvalidProgramData,
    #[msg("The program is paused")]
    Paused,
    #[msg("Window limits are invalid (need 0 < min <= max)")]
    InvalidLimits,
    #[msg("Spot counts are invalid or above the configured maximum")]
    InvalidSpotCounts,
    #[msg("Prices must be greater than zero")]
    InvalidPrice,
    #[msg("The spot price may not be above the maximum pack price")]
    SpotPriceAboveMaxPackPrice,
    #[msg("The sale window is invalid or outside the configured limits")]
    InvalidWindow,
    #[msg("The break is not in the right status for this action")]
    WrongStatus,
    #[msg("Spots can only be bought while the break is open")]
    NotInSaleWindow,
    #[msg("The break has not reached its closing time yet")]
    TooEarlyToClose,
    #[msg("All paid spots are sold")]
    SoldOut,
    #[msg("Spot index must be the next free index")]
    WrongSpotIndex,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Eligibility data is inconsistent (weight and entry count must both be zero or both positive)")]
    InvalidEligibility,
    #[msg("No packs to buy: the break has no paid spots sold and no eligible holders; cancel it")]
    EmptyPool,
    #[msg("Pool size does not match the number of packs that was funded")]
    PoolSizeMismatch,
    #[msg("This spot was already refunded")]
    AlreadyRefunded,
}
