use anchor_lang::prelude::*;

use crate::errors::BreaksError;

fn mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b).ok_or_else(|| BreaksError::MathOverflow.into())
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| BreaksError::MathOverflow.into())
}

fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or_else(|| BreaksError::MathOverflow.into())
}

/// What the first `count` packs of the list cost at most. `count` must not be above `prices.len()`.
fn cost_of_first(prices: &[u64], count: usize) -> Result<u64> {
    prices[..count].iter().try_fold(0u64, |sum, &price| add(sum, price))
}

// How a break is paid for.
//
// Every spot gets one pack, and the packs are bought cheapest first (see `packs.rs`), so a break that does not fill
// drops its most expensive packs. The pack a spot receives is drawn at random, so no spot "owns" a particular pack:
// what is fixed is who pays for how many. A free spot is paid for by the holder bucket at the AVERAGE price of the
// packs that are bought (rounded down), a paid spot by its buyer at the spot price, and the subsidy bucket pays what
// is left:
//
//   pack budget   = price of the first `pool_size` packs
//   from escrow   = sold spots × spot price
//   from holder   = drawn free spots × average pack price
//   from subsidy  = budget − escrow − holder
//
// The rule that keeps buyers from paying more than the packs cost: the spot price may not be above the average pack
// price. It is checked when the break is created (for the full list) and again when it is paid for (for the packs
// that are actually bought). A break that fails the second check is cancelled, not bought.

/// Worst case reserved in the treasury when a break is created: every paid spot fills and every free spot is drawn,
/// so every pack in the list is bought. Returns `(subsidy, holder)`.
pub fn creation_locks(paid_spots: u16, free_spots: u16, spot_price: u64, prices: &[u64]) -> Result<(u64, u64)> {
    let spots = u64::from(paid_spots) + u64::from(free_spots);
    require!(spots > 0 && prices.len() as u64 == spots, BreaksError::InvalidPackList);
    let total = cost_of_first(prices, prices.len())?;
    let average = total / spots;
    require!(spot_price <= average, BreaksError::SpotPriceAboveAveragePack);
    let holder = mul(u64::from(free_spots), average)?;
    // Cannot go below zero: the total is at least `spots × average`, which is at least the two parts taken from it.
    let subsidy = sub(sub(total, mul(u64::from(paid_spots), spot_price)?)?, holder)?;
    Ok((subsidy, holder))
}

/// How a closed break is paid for, given who actually showed up.
#[derive(Debug, PartialEq, Eq)]
pub struct Funding {
    /// Packs to buy: sold paid spots plus free spots that have an eligible holder.
    pub pool_size: u16,
    /// Most the buyer may spend: the prices of the first `pool_size` packs added up.
    pub pack_budget: u64,
    /// Paid out of the break's escrow (what the buyers paid).
    pub from_escrow: u64,
    /// Paid out of the locked subsidy bucket (the rest of the budget).
    pub from_subsidy: u64,
    /// Paid out of the locked holder bucket (the free spots, at the average pack price).
    pub from_holder: u64,
    /// Locked at creation but not needed: returned to the treasury.
    pub unlock_subsidy: u64,
    pub unlock_holder: u64,
}

/// Why a closed break cannot be paid for. Both are final: the number of sold spots and the eligibility list no longer change, so
/// neither can stop being true. Anyone may cancel such a break (`cancel_unfundable`); nobody can fund it.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Unfundable {
    /// No paid spot was sold and nobody is eligible: no pack to buy.
    EmptyPool,
    /// The packs that would be bought cost less, on average, than a buyer paid for a spot.
    PacksWorthLessThanSpots,
}

impl From<Unfundable> for BreaksError {
    fn from(reason: Unfundable) -> Self {
        match reason {
            Unfundable::EmptyPool => BreaksError::EmptyPool,
            Unfundable::PacksWorthLessThanSpots => BreaksError::PacksWorthLessThanSpots,
        }
    }
}

/// The packs a break buys, or why it cannot buy any: the first half of `funding`, shared with `unfundable` so the cancel that
/// anyone may send and the payment the keeper sends can never disagree about whether a break can be funded.
struct Pool {
    drawn_free: u16,
    pool_size: u16,
    pack_budget: u64,
    average: u64,
}

fn plan_pool(
    spots_sold: u16,
    free_spots: u16,
    eligible_count: u32,
    spot_price: u64,
    prices: &[u64],
) -> Result<std::result::Result<Pool, Unfundable>> {
    // Fewer eligible holders than free spots: the extra spots are not drawn and not bought.
    let drawn_free = u32::from(free_spots).min(eligible_count) as u16;
    let pool_size = spots_sold.checked_add(drawn_free).ok_or(BreaksError::MathOverflow)?;
    if pool_size == 0 {
        return Ok(Err(Unfundable::EmptyPool));
    }
    require!(usize::from(pool_size) <= prices.len(), BreaksError::InvalidPackList);

    let pack_budget = cost_of_first(prices, usize::from(pool_size))?;
    let average = pack_budget / u64::from(pool_size);
    // Buyers must not have paid more than the packs they get cost on average. With nobody having paid, there is nothing to protect.
    if spots_sold != 0 && spot_price > average {
        return Ok(Err(Unfundable::PacksWorthLessThanSpots));
    }
    Ok(Ok(Pool {
        drawn_free,
        pool_size,
        pack_budget,
        average,
    }))
}

/// Whether `fund_purchases` has to refuse this break for good, and why. `Ok(None)` means it can be funded. Only the two reasons
/// of `Unfundable` count: anything else that could go wrong (an overflow, a list shorter than the pool) is an error, not a
/// reason to cancel.
pub fn unfundable(
    spots_sold: u16,
    free_spots: u16,
    eligible_count: u32,
    spot_price: u64,
    prices: &[u64],
) -> Result<Option<Unfundable>> {
    Ok(plan_pool(spots_sold, free_spots, eligible_count, spot_price, prices)?.err())
}

pub fn funding(
    spots_sold: u16,
    free_spots: u16,
    eligible_count: u32,
    spot_price: u64,
    prices: &[u64],
    locked_subsidy: u64,
    locked_holder: u64,
) -> Result<Funding> {
    let Pool {
        drawn_free,
        pool_size,
        pack_budget,
        average,
    } = match plan_pool(spots_sold, free_spots, eligible_count, spot_price, prices)? {
        Ok(pool) => pool,
        Err(reason) => return Err(BreaksError::from(reason).into()),
    };

    let from_escrow = mul(u64::from(spots_sold), spot_price)?;
    let mut from_holder = mul(u64::from(drawn_free), average)?;
    let mut from_subsidy = sub(sub(pack_budget, from_escrow)?, from_holder)?;
    // The subsidy lock was sized for a full break; a partly filled one needs less of it, except for rounding dust (the
    // average is rounded down), which the holder lock covers. The sum of the two locks always covers the whole budget.
    if from_subsidy > locked_subsidy {
        let spill = from_subsidy - locked_subsidy;
        from_subsidy = locked_subsidy;
        from_holder = add(from_holder, spill)?;
    }

    Ok(Funding {
        pool_size,
        pack_budget,
        from_escrow,
        from_subsidy,
        from_holder,
        unlock_subsidy: sub(locked_subsidy, from_subsidy)?,
        unlock_holder: sub(locked_holder, from_holder)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::assert_fails_with;

    const P: u64 = 25_000_000; // $25 pack
    const S: u64 = 20_000_000; // $20 spot
    const D: u64 = 1_000_000; // one dollar

    fn same(price: u64, count: usize) -> Vec<u64> {
        vec![price; count]
    }

    /// 13 packs of $250, then 2 of $1000: the shape of a 15-spot break with two grails.
    fn grail_break() -> Vec<u64> {
        let mut v = same(250 * D, 13);
        v.extend(same(1000 * D, 2));
        v
    }

    // ---- one tier: the old rules

    #[test]
    fn creation_locks_cover_the_worst_case() {
        // 10 paid spots topped up by $5 each, 2 free spots at the full pack price.
        assert_eq!(
            creation_locks(10, 2, S, &same(P, 12)).unwrap(),
            (50_000_000, 50_000_000)
        );
        // A spot priced at the pack price needs no subsidy.
        assert_eq!(creation_locks(10, 2, P, &same(P, 12)).unwrap(), (0, 50_000_000));
        assert_eq!(creation_locks(10, 0, S, &same(P, 10)).unwrap(), (50_000_000, 0));
    }

    #[test]
    fn a_spot_price_above_the_pack_price_is_rejected() {
        assert_fails_with(
            creation_locks(1, 1, P + 1, &same(P, 2)),
            BreaksError::SpotPriceAboveAveragePack,
        );
        assert_fails_with(
            funding(1, 1, 1, P + 1, &same(P, 2), 0, 0),
            BreaksError::PacksWorthLessThanSpots,
        );
    }

    #[test]
    fn creation_locks_detect_overflow() {
        assert_fails_with(creation_locks(2, 1, 1, &same(u64::MAX, 3)), BreaksError::MathOverflow);
        // 3 free spots at an average near the top of u64 cannot be locked.
        assert_fails_with(
            creation_locks(1, 3, 1, &same(u64::MAX / 2, 4)),
            BreaksError::MathOverflow,
        );
    }

    #[test]
    fn full_break_uses_the_whole_lock() {
        let prices = same(P, 12);
        let (ls, lh) = creation_locks(10, 2, S, &prices).unwrap();
        let f = funding(10, 2, 50, S, &prices, ls, lh).unwrap();
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
        let prices = same(P, 14);
        let (ls, lh) = creation_locks(10, 4, S, &prices).unwrap();
        // 3 spots sold, only 1 eligible holder for 4 free spots.
        let f = funding(3, 4, 1, S, &prices, ls, lh).unwrap();
        assert_eq!(f.pool_size, 4);
        assert_eq!(f.pack_budget, 4 * P);
        assert_eq!(
            (f.from_escrow, f.from_subsidy, f.from_holder),
            (60_000_000, 15_000_000, 25_000_000)
        );
        assert_eq!((f.unlock_subsidy, f.unlock_holder), (ls - 15_000_000, lh - 25_000_000));
    }

    #[test]
    fn an_empty_pool_is_rejected() {
        assert_fails_with(funding(0, 3, 0, S, &same(P, 13), 0, 3 * P), BreaksError::EmptyPool);
        assert_fails_with(funding(0, 0, 10, S, &same(P, 10), 0, 0), BreaksError::EmptyPool);
    }

    // ---- a mixed list

    #[test]
    fn a_mixed_break_locks_by_the_average_pack_price() {
        // $250 × 13 + $1000 × 2 = $5250 over 15 spots: $350 on average.
        let prices = grail_break();
        // 13 paid spots at $300 bring in $3900. The free spots are worth 2 × $350 = $700 to the holder bucket,
        // and the subsidy bucket pays the remaining $5250 − $3900 − $700 = $650.
        assert_eq!(creation_locks(13, 2, 300 * D, &prices).unwrap(), (650 * D, 700 * D));
        // At the average price the buyers pay for everything but the free spots.
        assert_eq!(creation_locks(13, 2, 350 * D, &prices).unwrap(), (0, 700 * D));
        assert_fails_with(
            creation_locks(13, 2, 350 * D + 1, &prices),
            BreaksError::SpotPriceAboveAveragePack,
        );
    }

    #[test]
    fn the_list_must_have_one_price_per_spot() {
        assert_fails_with(creation_locks(13, 2, D, &same(P, 14)), BreaksError::InvalidPackList);
        assert_fails_with(creation_locks(13, 2, D, &same(P, 16)), BreaksError::InvalidPackList);
        assert_fails_with(creation_locks(0, 0, D, &[]), BreaksError::InvalidPackList);
    }

    #[test]
    fn a_full_mixed_break_buys_every_pack() {
        let prices = grail_break();
        let (ls, lh) = creation_locks(13, 2, 300 * D, &prices).unwrap();
        let f = funding(13, 2, 40, 300 * D, &prices, ls, lh).unwrap();
        assert_eq!(f.pool_size, 15);
        assert_eq!(f.pack_budget, 5250 * D);
        assert_eq!(
            (f.from_escrow, f.from_subsidy, f.from_holder),
            (3900 * D, 650 * D, 700 * D)
        );
        assert_eq!((f.unlock_subsidy, f.unlock_holder), (0, 0));
    }

    #[test]
    fn a_break_that_does_not_fill_drops_the_most_expensive_packs() {
        let prices = grail_break();
        let (ls, lh) = creation_locks(13, 2, 300 * D, &prices).unwrap();
        // 12 sold and 2 free: the first 14 packs, so one grail is dropped. $250 × 13 + $1000 = $4250.
        let f = funding(12, 2, 40, 300 * D, &prices, ls, lh).unwrap();
        assert_eq!((f.pool_size, f.pack_budget), (14, 4250 * D));
        // The average of what is bought is $303.57…, rounded down to 303_571_428 micro-dollars.
        assert_eq!(f.from_escrow, 3600 * D);
        assert_eq!(f.from_holder, 2 * 303_571_428);
        assert_eq!(f.from_subsidy, 4250 * D - 3600 * D - 2 * 303_571_428);
        assert_eq!(f.from_escrow + f.from_subsidy + f.from_holder, f.pack_budget);
        assert_eq!(f.unlock_subsidy, ls - f.from_subsidy);
        assert_eq!(f.unlock_holder, lh - f.from_holder);
    }

    #[test]
    fn a_break_whose_bought_packs_are_worth_less_than_the_spots_is_not_funded() {
        let prices = grail_break();
        let (ls, lh) = creation_locks(13, 2, 300 * D, &prices).unwrap();
        // 5 sold and 2 free: seven $250 packs against spots that cost $300.
        assert_fails_with(
            funding(5, 2, 40, 300 * D, &prices, ls, lh),
            BreaksError::PacksWorthLessThanSpots,
        );
        // The same break with a $250 spot price is fine.
        let (ls, lh) = creation_locks(13, 2, 250 * D, &prices).unwrap();
        let f = funding(5, 2, 40, 250 * D, &prices, ls, lh).unwrap();
        assert_eq!(
            (f.pack_budget, f.from_escrow, f.from_holder, f.from_subsidy),
            (1750 * D, 1250 * D, 500 * D, 0)
        );
    }

    #[test]
    fn the_edge_is_exactly_the_average_of_the_bought_packs() {
        let prices = grail_break();
        // 13 sold, no holders: the 13 cheapest packs, $250 each. A $250 spot is fine, one micro-dollar more is not.
        let lock = |spot| creation_locks(13, 2, spot, &prices).unwrap();
        let (ls, lh) = lock(250 * D);
        assert!(funding(13, 2, 0, 250 * D, &prices, ls, lh).is_ok());
        let (ls, lh) = lock(250 * D + 1);
        assert_fails_with(
            funding(13, 2, 0, 250 * D + 1, &prices, ls, lh),
            BreaksError::PacksWorthLessThanSpots,
        );
    }

    #[test]
    fn with_no_paid_spots_sold_the_free_spots_are_still_bought() {
        let prices = grail_break();
        let (ls, lh) = creation_locks(13, 2, 350 * D, &prices).unwrap();
        // Nobody bought; two holders won. Two $250 packs, all paid by the holder bucket.
        let f = funding(0, 2, 5, 350 * D, &prices, ls, lh).unwrap();
        assert_eq!((f.pool_size, f.pack_budget, f.from_escrow), (2, 500 * D, 0));
        assert_eq!((f.from_holder, f.from_subsidy), (500 * D, 0));
        assert_eq!((f.unlock_subsidy, f.unlock_holder), (ls, lh - 500 * D));
    }

    #[test]
    fn a_list_shorter_than_the_pool_is_refused_not_read_past_its_end() {
        assert_fails_with(funding(3, 0, 0, D, &same(P, 2), 0, 0), BreaksError::InvalidPackList);
    }

    #[test]
    fn rounding_dust_is_covered_by_the_holder_lock() {
        // Prices in micro-dollars, nearly equal, so the average of what is bought (10.9, rounded down to 10) sits just
        // under the average of the full list (11). Five spots sold, five holders: the free spots are paid at 10 each,
        // which leaves the subsidy bucket 9 to pay, more than the 5 it locked. The 4 that are over come from the holder lock.
        let mut prices = vec![10];
        prices.extend(same(11, 9));
        prices.push(12);
        let (ls, lh) = creation_locks(5, 6, 10, &prices).unwrap();
        assert_eq!((ls, lh), (5, 66));
        let f = funding(5, 6, 5, 10, &prices, ls, lh).unwrap();
        assert_eq!(f.pack_budget, 109);
        assert_eq!((f.from_escrow, f.from_subsidy, f.from_holder), (50, 5, 54));
        assert_eq!((f.unlock_subsidy, f.unlock_holder), (0, 12));
    }

    // ---- a break that cannot be paid for: anyone may cancel it

    #[test]
    fn a_break_nobody_joined_is_unfundable() {
        let prices = grail_break();
        // Nobody bought a spot and nobody is eligible: no pack to buy.
        assert_eq!(
            unfundable(0, 2, 0, 300 * D, &prices).unwrap(),
            Some(Unfundable::EmptyPool)
        );
        // One eligible holder is enough to buy a pack for.
        assert_eq!(unfundable(0, 2, 1, 300 * D, &prices).unwrap(), None);
        // A paid spot is enough too, with no free spots at all.
        assert_eq!(unfundable(1, 0, 0, 10 * D, &same(P, 3)).unwrap(), None);
        // A break with no free spots and no buyers has nothing to fund.
        assert_eq!(
            unfundable(0, 0, 0, 10 * D, &same(P, 3)).unwrap(),
            Some(Unfundable::EmptyPool)
        );
    }

    #[test]
    fn a_break_whose_bought_packs_are_worth_less_than_the_spots_is_unfundable() {
        let prices = grail_break();
        // Two buyers paid $300 and no holder is eligible: the first two packs cost $250 each.
        assert_eq!(
            unfundable(2, 2, 0, 300 * D, &prices).unwrap(),
            Some(Unfundable::PacksWorthLessThanSpots)
        );
        // With the two free spots drawn the first four packs still average $250.
        assert_eq!(
            unfundable(2, 2, 9, 300 * D, &prices).unwrap(),
            Some(Unfundable::PacksWorthLessThanSpots)
        );
        // Filled, both grails are bought and the average is $350.
        assert_eq!(unfundable(13, 2, 9, 300 * D, &prices).unwrap(), None);
    }

    #[test]
    fn the_edge_is_the_same_as_the_one_funding_refuses_at() {
        let prices = vec![10 * D, 10 * D, 100 * D, 100 * D]; // the whole list averages $55
                                                             // Two sold spots at $55: the first two packs average $10, far below.
        assert_eq!(
            unfundable(2, 0, 0, 55 * D, &prices).unwrap(),
            Some(Unfundable::PacksWorthLessThanSpots)
        );
        // At exactly the average of what is bought, it is fundable; one micro-dollar above, it is not.
        assert_eq!(unfundable(2, 0, 0, 10 * D, &prices).unwrap(), None);
        assert_eq!(
            unfundable(2, 0, 0, 10 * D + 1, &prices).unwrap(),
            Some(Unfundable::PacksWorthLessThanSpots)
        );
        assert!(funding(2, 0, 0, 10 * D, &prices, 0, 0).is_ok());
        assert_fails_with(
            funding(2, 0, 0, 10 * D + 1, &prices, 0, 0),
            BreaksError::PacksWorthLessThanSpots,
        );
    }

    #[test]
    fn with_nobody_having_paid_the_spot_price_protects_nobody() {
        // Free spots only: the check against the spot price does not apply, as in `funding`.
        assert_eq!(unfundable(0, 2, 2, 999 * D, &same(P, 4)).unwrap(), None);
    }

    #[test]
    fn other_problems_are_errors_not_reasons_to_cancel() {
        // A list shorter than the pool is a broken break, not an unfundable one.
        assert_fails_with(unfundable(3, 0, 0, D, &same(P, 2)), BreaksError::InvalidPackList);
        // A pool that does not fit in 16 bits is an overflow.
        assert_fails_with(unfundable(u16::MAX, 1, 1, D, &same(P, 2)), BreaksError::MathOverflow);
        // A list whose cost does not fit in 64 bits cannot be added up.
        assert_fails_with(unfundable(2, 0, 0, 1, &[u64::MAX, 1]), BreaksError::MathOverflow);
    }

    #[test]
    fn the_reasons_are_the_errors_funding_gives() {
        // `BreaksError` has no equality of its own: compare the numbers the chain reports.
        assert_eq!(
            u32::from(BreaksError::from(Unfundable::EmptyPool)),
            u32::from(BreaksError::EmptyPool)
        );
        assert_eq!(
            u32::from(BreaksError::from(Unfundable::PacksWorthLessThanSpots)),
            u32::from(BreaksError::PacksWorthLessThanSpots)
        );
    }

    // ---- everything that must hold for any list

    /// A small deterministic generator, so the sweep needs no dependency and fails the same way every time.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self, below: u64) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) % below
        }
    }

    #[test]
    fn the_budget_is_always_exactly_the_sum_of_its_sources() {
        let mut rng = Rng(7);
        let mut checked = 0u32;
        let mut spilled = 0u32;
        for round in 0..400 {
            // Small prices make rounding visible; some rounds use dollar-sized ones.
            let scale = if round % 4 == 0 { D } else { 1 };
            let spots = 1 + rng.next(24) as usize;
            let free = rng.next(spots.min(16) as u64 + 1) as usize;
            let free = free.min(spots - 1);
            let paid = spots - free;
            // Every third list has nearly equal prices, where rounding matters most.
            let jitter = round % 3 == 1;
            let base = 1 + rng.next(2000);
            let mut prices: Vec<u64> = (0..spots)
                .map(|_| if jitter { base + rng.next(3) } else { 1 + rng.next(2000) } * scale)
                .collect();
            prices.sort_unstable();
            let average = prices.iter().sum::<u64>() / spots as u64;
            let spot = rng.next(average + 1);
            let (ls, lh) = creation_locks(paid as u16, free as u16, spot, &prices).unwrap();
            assert_eq!(
                ls + lh + paid as u64 * spot,
                prices.iter().sum::<u64>(),
                "the locks plus the buyers pay the whole list"
            );

            for sold in 0..=paid as u16 {
                for eligible in 0..=(free as u32 + 1) {
                    let result = funding(sold, free as u16, eligible, spot, &prices, ls, lh);
                    // The cancel anyone may send and the payment the keeper sends can never disagree: a break is
                    // unfundable exactly when funding refuses it, and for exactly that reason.
                    let reason = unfundable(sold, free as u16, eligible, spot, &prices).unwrap();
                    match (&result, reason) {
                        (Ok(_), None) => {}
                        (Err(_), Some(why)) => assert_fails_with(
                            funding(sold, free as u16, eligible, spot, &prices, ls, lh),
                            BreaksError::from(why),
                        ),
                        _ => {
                            panic!("funding and unfundable disagree for {sold} sold, {eligible} eligible, spot {spot}")
                        }
                    }
                    let drawn = (free as u32).min(eligible) as u16;
                    let Ok(f) = result else {
                        // The only allowed failures: nobody to buy for, or the bought packs are worth less than the spots.
                        let k = usize::from(sold + drawn);
                        if k == 0 {
                            assert_fails_with(result, BreaksError::EmptyPool);
                        } else {
                            let cost: u64 = prices[..k].iter().sum();
                            assert!(
                                sold > 0 && spot > cost / k as u64,
                                "refused a break it should have funded"
                            );
                            assert_fails_with(result, BreaksError::PacksWorthLessThanSpots);
                        }
                        continue;
                    };
                    checked += 1;
                    let k = usize::from(f.pool_size);
                    assert_eq!(k, usize::from(sold + drawn));
                    assert_eq!(f.pack_budget, prices[..k].iter().sum::<u64>());
                    assert_eq!(f.from_escrow + f.from_subsidy + f.from_holder, f.pack_budget);
                    assert_eq!(f.from_subsidy + f.unlock_subsidy, ls);
                    assert_eq!(f.from_holder + f.unlock_holder, lh);
                    // Never more than was locked, and the buyers never pay more than the packs cost on average.
                    assert!(f.from_subsidy <= ls && f.from_holder <= lh);
                    assert!(sold == 0 || spot <= f.pack_budget / k as u64);
                    let average = f.pack_budget / k as u64;
                    if f.from_holder != u64::from(drawn) * average {
                        spilled += 1;
                        // Rounding dust only: less than one micro-dollar per pack.
                        assert!(f.from_holder - u64::from(drawn) * average < k as u64);
                    }
                }
            }
        }
        assert!(
            checked > 5000,
            "the sweep should reach many funded breaks, reached {checked}"
        );
        assert!(spilled > 0, "the sweep should reach the rounding case");
    }
}
