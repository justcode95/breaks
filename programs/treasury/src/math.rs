use anchor_lang::prelude::*;

use crate::errors::TreasuryError;

pub const BPS_DENOMINATOR: u16 = 10_000;

/// The two shares must cover the whole deposit.
pub fn validate_split(subsidy_bps: u16, holder_bps: u16) -> Result<()> {
    require!(
        u32::from(subsidy_bps) + u32::from(holder_bps) == u32::from(BPS_DENOMINATOR),
        TreasuryError::InvalidSplit
    );
    Ok(())
}

/// Returns `(to_subsidy, to_holder)`. The subsidy bucket gets `floor(amount * subsidy_bps / 10_000)`
/// and the holder bucket gets the remainder, so no base unit is ever lost to rounding.
pub fn split(amount: u64, subsidy_bps: u16) -> Result<(u64, u64)> {
    let to_subsidy = u128::from(amount)
        .checked_mul(u128::from(subsidy_bps))
        .map(|v| v / u128::from(BPS_DENOMINATOR))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(TreasuryError::MathOverflow)?;
    let to_holder = amount.checked_sub(to_subsidy).ok_or(TreasuryError::MathOverflow)?;
    Ok((to_subsidy, to_holder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_split_is_70_30() {
        assert_eq!(split(100_000_000, 7_000).unwrap(), (70_000_000, 30_000_000));
    }

    #[test]
    fn remainder_goes_to_holder_bucket() {
        // 1 * 7000 / 10000 = 0 (floor), so the single base unit lands in the holder bucket.
        assert_eq!(split(1, 7_000).unwrap(), (0, 1));
        assert_eq!(split(3, 7_000).unwrap(), (2, 1));
    }

    #[test]
    fn extremes() {
        assert_eq!(split(123, 0).unwrap(), (0, 123));
        assert_eq!(split(123, 10_000).unwrap(), (123, 0));
        assert_eq!(split(0, 7_000).unwrap(), (0, 0));
    }

    #[test]
    fn max_amount_does_not_overflow() {
        let (s, h) = split(u64::MAX, 7_000).unwrap();
        assert_eq!(u128::from(s) + u128::from(h), u128::from(u64::MAX));
        assert_eq!(split(u64::MAX, 10_000).unwrap(), (u64::MAX, 0));
    }

    #[test]
    fn parts_always_add_up_and_subsidy_grows_with_its_share() {
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..2_000 {
            // xorshift so the cases are deterministic but spread over the whole u64 range
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let bps = (x % 10_001) as u16;
            let (s, h) = split(x, bps).unwrap();
            assert_eq!(u128::from(s) + u128::from(h), u128::from(x));
            if bps < 10_000 {
                assert!(split(x, bps + 1).unwrap().0 >= s);
            }
        }
    }

    #[test]
    fn split_must_add_up_to_10000() {
        assert!(validate_split(7_000, 3_000).is_ok());
        assert!(validate_split(0, 10_000).is_ok());
        assert!(validate_split(10_000, 0).is_ok());
        assert!(validate_split(7_000, 2_999).is_err());
        assert!(validate_split(7_000, 3_001).is_err());
        assert!(validate_split(u16::MAX, u16::MAX).is_err());
    }
}
