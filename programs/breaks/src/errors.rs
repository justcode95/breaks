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
    #[msg("The spot price may not be above the average price of the packs in the break")]
    SpotPriceAboveAveragePack,
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
    #[msg("The randomness record is missing, not owned by the adapter, or belongs to another request")]
    InvalidRandomnessRecord,
    #[msg("The adapter has not produced the randomness yet")]
    RandomnessNotFulfilled,
    #[msg("The previous request was already fulfilled: settle it instead of asking again")]
    AlreadyFulfilled,
    #[msg("The previous request has not timed out yet")]
    RequestNotTimedOut,
    #[msg("Too many randomness requests for this break")]
    TooManyAttempts,
    #[msg("The randomness adapter must be a program and the timeout must be positive")]
    InvalidRandomnessConfig,
    #[msg("Winners must be claimed in order, and no more than the draw produces")]
    WrongClaimIndex,
    #[msg("The proof does not lead to the committed eligibility root")]
    InvalidProof,
    #[msg("This wallet is not the one the draw picked for this winner")]
    NotTheDrawnWinner,
    #[msg("This wallet was already drawn")]
    WinnerAlreadyDrawn,
    #[msg("The pack list is invalid: one pack per spot, every tier used, tiers listed cheapest first")]
    InvalidPackList,
    #[msg("The packs that can be bought are worth less than the spots cost: cancel the break")]
    PacksWorthLessThanSpots,
    #[msg("This break can be funded: only the admin can cancel it")]
    BreakIsFundable,
}

/// Unit-test helper: the result failed with exactly this program error.
#[cfg(test)]
pub fn assert_fails_with<T: std::fmt::Debug>(result: Result<T>, expected: BreaksError) {
    match result.unwrap_err() {
        Error::AnchorError(e) => assert_eq!(e.error_code_number, u32::from(expected), "wrong error: {}", e.error_msg),
        other => panic!("not a program error: {other:?}"),
    }
}
