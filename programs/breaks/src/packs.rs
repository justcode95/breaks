//! The packs of a break: which Collector Crypt machines it buys from and in what order the packs are included.
//!
//! A break lists a few `tiers` (a machine and the most one pack from it may cost) and, for each spot, the tier its pack
//! comes from. Packs are listed cheapest first. That order is the rule for a break that does not fill: only as many
//! packs are bought as there are spots in the pool, always the first ones, so the most expensive packs (the chase) are
//! the ones that drop out. The list is committed when the break is created and never changes.

use anchor_lang::prelude::*;

use crate::{
    errors::BreaksError,
    state::{PackTier, MAX_PACKS, MAX_TIERS},
};

/// Checks a pack list before a break is created from it.
///
/// - one pack per spot, paid and free together, and no more than `MAX_PACKS`;
/// - between 1 and `MAX_TIERS` tiers, each with a price above zero;
/// - every pack names a tier that exists, and every tier is used (so the committed list says nothing that is not true);
/// - the prices never go down along the list.
pub fn check_list(tiers: &[PackTier], packs: &[u8], paid_spots: u16, free_spots: u16) -> Result<()> {
    // At least one tier follows from the rest: a break has a pack, and a pack names a tier.
    require!(tiers.len() <= MAX_TIERS, BreaksError::InvalidPackList);
    require!(tiers.iter().all(|t| t.max_price > 0), BreaksError::InvalidPrice);
    let spots = usize::from(paid_spots) + usize::from(free_spots);
    require!(
        spots > 0 && spots <= MAX_PACKS && packs.len() == spots,
        BreaksError::InvalidPackList
    );
    require!(
        packs.iter().all(|&t| usize::from(t) < tiers.len()),
        BreaksError::InvalidPackList
    );
    let mut used = [false; MAX_TIERS];
    for &t in packs {
        used[usize::from(t)] = true;
    }
    require!(used[..tiers.len()].iter().all(|&u| u), BreaksError::InvalidPackList);
    require!(
        packs
            .windows(2)
            .all(|w| tiers[usize::from(w[0])].max_price <= tiers[usize::from(w[1])].max_price),
        BreaksError::InvalidPackList
    );
    Ok(())
}

/// The most each pack may cost, in list order. Call `check_list` first: indexes are not checked here.
pub fn prices(tiers: &[PackTier], packs: &[u8]) -> Vec<u64> {
    packs.iter().map(|&t| tiers[usize::from(t)].max_price).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::assert_fails_with as assert_invalid;

    const USDC: u64 = 1_000_000;

    fn tier(machine: u8, dollars: u64) -> PackTier {
        PackTier {
            machine: [machine; 32],
            max_price: dollars * USDC,
        }
    }

    #[test]
    fn a_list_of_one_tier_is_valid() {
        check_list(&[tier(1, 25)], &[0; 12], 10, 2).unwrap();
    }

    #[test]
    fn a_mixed_list_cheapest_first_is_valid() {
        let tiers = [tier(1, 250), tier(2, 1000), tier(3, 100)];
        // 100, 100, 250, 250, 1000, 1000
        check_list(&tiers, &[2, 2, 0, 0, 1, 1], 4, 2).unwrap();
        assert_eq!(
            prices(&tiers, &[2, 2, 0, 0, 1, 1]),
            [100, 100, 250, 250, 1000, 1000].map(|d| d * USDC)
        );
    }

    #[test]
    fn two_tiers_with_the_same_price_may_follow_each_other_in_any_order() {
        let tiers = [tier(1, 100), tier(2, 100)];
        check_list(&tiers, &[0, 1, 0, 1], 3, 1).unwrap();
    }

    #[test]
    fn a_list_that_goes_down_is_refused() {
        let tiers = [tier(1, 100), tier(2, 1000)];
        assert_invalid(check_list(&tiers, &[1, 0], 1, 1), BreaksError::InvalidPackList);
        assert_invalid(check_list(&tiers, &[0, 1, 0], 2, 1), BreaksError::InvalidPackList);
    }

    #[test]
    fn the_list_must_have_one_pack_per_spot() {
        let t = [tier(1, 100)];
        assert_invalid(check_list(&t, &[0; 11], 10, 2), BreaksError::InvalidPackList);
        assert_invalid(check_list(&t, &[0; 13], 10, 2), BreaksError::InvalidPackList);
        assert_invalid(check_list(&t, &[], 0, 0), BreaksError::InvalidPackList);
    }

    #[test]
    fn at_most_the_capacity_of_packs() {
        let t = [tier(1, 100)];
        check_list(&t, &[0; MAX_PACKS], (MAX_PACKS - 4) as u16, 4).unwrap();
        assert_invalid(
            check_list(&t, &[0; MAX_PACKS + 1], (MAX_PACKS - 3) as u16, 4),
            BreaksError::InvalidPackList,
        );
    }

    #[test]
    fn a_pack_must_name_a_tier_that_exists() {
        let t = [tier(1, 100), tier(2, 200)];
        assert_invalid(check_list(&t, &[0, 2], 1, 1), BreaksError::InvalidPackList);
        assert_invalid(check_list(&t, &[0, 255], 1, 1), BreaksError::InvalidPackList);
        // The first index past the end, with every listed tier used: only the index check can refuse this.
        assert_invalid(check_list(&t, &[0, 1, 2], 2, 1), BreaksError::InvalidPackList);
    }

    #[test]
    fn every_tier_must_be_used() {
        let t = [tier(1, 100), tier(2, 200), tier(3, 300)];
        assert_invalid(check_list(&t, &[0, 0, 2, 2], 2, 2), BreaksError::InvalidPackList);
        check_list(&t, &[0, 1, 2], 2, 1).unwrap();
    }

    #[test]
    fn between_one_and_eight_tiers() {
        assert_invalid(check_list(&[], &[0], 1, 0), BreaksError::InvalidPackList);
        let nine: Vec<PackTier> = (1..=9).map(|d| tier(d as u8, d)).collect();
        let packs: Vec<u8> = (0..9).collect();
        assert_invalid(check_list(&nine, &packs, 9, 0), BreaksError::InvalidPackList);
        let eight = &nine[..8];
        let packs: Vec<u8> = (0..8).collect();
        check_list(eight, &packs, 6, 2).unwrap();
    }

    #[test]
    fn a_tier_price_of_zero_is_refused() {
        let t = [tier(1, 0)];
        assert_invalid(check_list(&t, &[0], 1, 0), BreaksError::InvalidPrice);
    }
}
