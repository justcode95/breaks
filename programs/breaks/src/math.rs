use anchor_lang::prelude::*;

use crate::errors::BreaksError;

fn mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b).ok_or_else(|| BreaksError::MathOverflow.into())
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| BreaksError::MathOverflow.into())
}

/// Worst case reserved in the treasury when a break is created: every paid spot fills (the
/// subsidy bucket tops each one up to the pack price) and every free spot is drawn (the holder
/// bucket pays the whole pack). Returns `(subsidy, holder)`.
pub fn creation_locks(paid_spots: u16, free_spots: u16, spot_price: u64, max_pack_price: u64) -> Result<(u64, u64)> {
    let top_up = max_pack_price
        .checked_sub(spot_price)
        .ok_or(BreaksError::SpotPriceAboveMaxPackPrice)?;
    Ok((
        mul(u64::from(paid_spots), top_up)?,
        mul(u64::from(free_spots), max_pack_price)?,
    ))
}

/// How a closed break is paid for, given who actually showed up.
#[derive(Debug, PartialEq, Eq)]
pub struct Funding {
    /// Packs to buy: sold paid spots plus free spots that have an eligible holder.
    pub pool_size: u16,
    /// Most the buyer may spend: `pool_size * max_pack_price`.
    pub pack_budget: u64,
    /// Paid out of the break's escrow (what the buyers paid).
    pub from_escrow: u64,
    /// Paid out of the locked subsidy bucket (tops up each sold spot to the pack price).
    pub from_subsidy: u64,
    /// Paid out of the locked holder bucket (whole packs for the free spots).
    pub from_holder: u64,
    /// Locked at creation but not needed: returned to the treasury.
    pub unlock_subsidy: u64,
    pub unlock_holder: u64,
}

pub fn funding(
    spots_sold: u16,
    free_spots: u16,
    eligible_count: u32,
    spot_price: u64,
    max_pack_price: u64,
    locked_subsidy: u64,
    locked_holder: u64,
) -> Result<Funding> {
    // Fewer eligible holders than free spots: the extra spots are not drawn and not bought.
    let drawn_free = u32::from(free_spots).min(eligible_count) as u16;
    let pool_size = spots_sold.checked_add(drawn_free).ok_or(BreaksError::MathOverflow)?;
    require!(pool_size > 0, BreaksError::EmptyPool);

    let top_up = max_pack_price
        .checked_sub(spot_price)
        .ok_or(BreaksError::SpotPriceAboveMaxPackPrice)?;
    let from_escrow = mul(u64::from(spots_sold), spot_price)?;
    let from_subsidy = mul(u64::from(spots_sold), top_up)?;
    let from_holder = mul(u64::from(drawn_free), max_pack_price)?;
    let pack_budget = mul(u64::from(pool_size), max_pack_price)?;
    require!(
        add(add(from_escrow, from_subsidy)?, from_holder)? == pack_budget,
        BreaksError::MathOverflow
    );

    Ok(Funding {
        pool_size,
        pack_budget,
        from_escrow,
        from_subsidy,
        from_holder,
        unlock_subsidy: locked_subsidy
            .checked_sub(from_subsidy)
            .ok_or(BreaksError::MathOverflow)?,
        unlock_holder: locked_holder
            .checked_sub(from_holder)
            .ok_or(BreaksError::MathOverflow)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: u64 = 25_000_000; // $25 pack
    const S: u64 = 20_000_000; // $20 spot

    #[test]
    fn creation_locks_cover_the_worst_case() {
        // 10 paid spots topped up by $5 each, 2 free spots at the full pack price.
        assert_eq!(creation_locks(10, 2, S, P).unwrap(), (50_000_000, 50_000_000));
        // A spot priced at the pack price needs no subsidy.
        assert_eq!(creation_locks(10, 2, P, P).unwrap(), (0, 50_000_000));
        assert_eq!(creation_locks(10, 0, S, P).unwrap(), (50_000_000, 0));
    }

    #[test]
    fn a_spot_price_above_the_pack_price_is_rejected() {
        assert!(creation_locks(1, 1, P + 1, P).is_err());
        assert!(funding(1, 1, 1, P + 1, P, 0, 0).is_err());
    }

    #[test]
    fn creation_locks_detect_overflow() {
        assert!(creation_locks(u16::MAX, u16::MAX, 1, u64::MAX).is_err());
    }

    #[test]
    fn full_break_uses_the_whole_lock() {
        let (ls, lh) = creation_locks(10, 2, S, P).unwrap();
        let f = funding(10, 2, 50, S, P, ls, lh).unwrap();
        assert_eq!(f.pool_size, 12);
        assert_eq!(f.pack_budget, 12 * P);
        assert_eq!(
            (f.from_escrow, f.from_subsidy, f.from_holder),
            (200_000_000, 50_000_000, 50_000_000)
        );
        assert_eq!((f.unlock_subsidy, f.unlock_holder), (0, 0));
    }

    #[test]
    fn unsold_spots_and_missing_holders_release_their_share_of_the_lock() {
        let (ls, lh) = creation_locks(10, 4, S, P).unwrap();
        // 3 spots sold, only 1 eligible holder for 4 free spots.
        let f = funding(3, 4, 1, S, P, ls, lh).unwrap();
        assert_eq!(f.pool_size, 4);
        assert_eq!(f.pack_budget, 4 * P);
        assert_eq!(
            (f.from_escrow, f.from_subsidy, f.from_holder),
            (60_000_000, 15_000_000, 25_000_000)
        );
        assert_eq!((f.unlock_subsidy, f.unlock_holder), (ls - 15_000_000, lh - 25_000_000));
    }

    #[test]
    fn the_budget_is_always_exactly_the_sum_of_its_sources() {
        for sold in [0u16, 1, 7, 10] {
            for free in [0u16, 1, 3] {
                for eligible in [0u32, 1, 2, 100] {
                    let (ls, lh) = creation_locks(10, free, S, P).unwrap();
                    let Ok(f) = funding(sold, free, eligible, S, P, ls, lh) else {
                        // The only allowed failure is an empty pool.
                        assert_eq!(sold as u32 + u32::from(free).min(eligible), 0);
                        continue;
                    };
                    assert_eq!(f.from_escrow + f.from_subsidy + f.from_holder, f.pack_budget);
                    assert_eq!(f.pack_budget, u64::from(f.pool_size) * P);
                    assert_eq!(f.from_subsidy + f.unlock_subsidy, ls);
                    assert_eq!(f.from_holder + f.unlock_holder, lh);
                }
            }
        }
    }

    #[test]
    fn an_empty_pool_is_rejected() {
        assert!(funding(0, 3, 0, S, P, 0, 3 * P).is_err());
        assert!(funding(0, 0, 10, S, P, 0, 0).is_err());
    }
}
