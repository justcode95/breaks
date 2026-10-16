//! On-chain tests for the breaks program. Both programs run inside LiteSVM, so the treasury
//! locking, pay-outs and every account check are the real thing (see `testkit`).
//!
//! Needs both SBF builds first:
//! `cargo build-sbf --manifest-path programs/treasury/Cargo.toml` and the same for `breaks`.

use anchor_lang::InstructionData;
use breaks::{
    errors::BreaksError,
    randomness::{draw_seed, parse_request, RequestState},
    state::{BreakStatus, PackTier, Spot},
    BreakCancelled, BreakClosed, BreakCreated, CreateBreakParams, EligibilityCommitted, FreeWinnerClaimed,
    PoolCommitted, PurchasesFunded, RandomnessRequested, RandomnessSettled, SpotBought, SpotRefunded,
};
use draw_core::{draw_free_winners, leaf_node, parent, Leaf, Tree};
use litesvm_token::{get_spl_account, spl_token::state::Account as TokenAccountState};
use solana_address::Address;
use solana_signer::Signer;
use testkit::*;
use treasury::errors::TreasuryError;

mod common;
use common::*;

// ---------------------------------------------------------------- initialize and admin

#[test]
fn initialize_stores_the_config_and_takes_the_mint_from_the_treasury() {
    let env = Env::ready();
    let c = env.config();
    assert_eq!(
        (c.admin, c.keeper, c.buyer),
        (env.admin.pubkey(), env.keeper.pubkey(), env.buyer.pubkey())
    );
    assert_eq!(c.usdc_mint, env.mint);
    assert_eq!((c.next_break_id, c.paused), (0, false));
    assert_eq!(
        (c.min_window_secs, c.max_window_secs, c.max_paid_spots, c.max_free_spots),
        (6 * HOUR, 24 * HOUR, 20, 6)
    );
    // The treasury's locked counters start at zero and the breaks program is its controller.
    assert_eq!(env.locked(), (0, 0));
    let t: treasury::state::Config = env.read(&treasury_config());
    assert_eq!(t.controller, treasury_authority());
}

#[test]
fn initialize_is_only_for_the_upgrade_authority() {
    let mut env = Env::base();
    let (stranger, _) = env.user(0);
    let i = env.initialize_ix(&stranger.pubkey(), env.breaks_programdata);
    assert_fails_with(
        send(&mut env.svm, &stranger, &[], &[i]),
        code(BreaksError::Unauthorized),
    );
    assert!(env.svm.get_account(&breaks_config()).is_none());
}

#[test]
fn initialize_rejects_nonsense_limits() {
    let mut env = Env::base();
    let mut i = env.initialize_ix(&env.authority.pubkey(), env.breaks_programdata);
    // Rebuild the data with min window > max window.
    i.data = breaks::instruction::Initialize {
        params: breaks::InitializeParams {
            admin: env.admin.pubkey(),
            keeper: env.keeper.pubkey(),
            buyer: env.buyer.pubkey(),
            min_window_secs: 10 * HOUR,
            max_window_secs: 6 * HOUR,
            max_paid_spots: 20,
            max_free_spots: 6,
            randomness_program: mock_orao::ID,
            randomness_timeout_secs: HOUR,
        },
    }
    .data();
    assert_fails_with(env.send_as_authority(&[i]), code(BreaksError::InvalidLimits));
}

#[test]
fn only_the_admin_can_change_keeper_buyer_and_pause() {
    let mut env = Env::ready();
    let admin = env.admin.insecure_clone();
    let keeper = env.keeper.insecure_clone();
    let (new_key, _) = env.user(0);

    for who in [&keeper, &new_key] {
        assert_fails_with(
            env.admin_call(
                who,
                breaks::instruction::SetKeeper {
                    keeper: new_key.pubkey(),
                },
            ),
            code(BreaksError::Unauthorized),
        );
        assert_fails_with(
            env.admin_call(
                who,
                breaks::instruction::SetBuyer {
                    buyer: new_key.pubkey(),
                },
            ),
            code(BreaksError::Unauthorized),
        );
        assert_fails_with(
            env.admin_call(who, breaks::instruction::SetPaused { paused: true }),
            code(BreaksError::Unauthorized),
        );
    }
    env.admin_call(
        &admin,
        breaks::instruction::SetKeeper {
            keeper: new_key.pubkey(),
        },
    )
    .unwrap();
    env.admin_call(
        &admin,
        breaks::instruction::SetBuyer {
            buyer: new_key.pubkey(),
        },
    )
    .unwrap();
    env.admin_call(&admin, breaks::instruction::SetPaused { paused: true })
        .unwrap();
    let c = env.config();
    assert_eq!(
        (c.keeper, c.buyer, c.paused),
        (new_key.pubkey(), new_key.pubkey(), true)
    );
    // The old keeper no longer works.
    env.set_paused(false);
    assert_fails_with(env.create_break_with(params()), code(BreaksError::Unauthorized));
}

// ---------------------------------------------------------------- create_break

#[test]
fn create_break_locks_the_worst_case_in_the_treasury_and_opens_an_escrow() {
    let mut env = Env::ready();
    let keeper = env.keeper.insecure_clone();
    let i = env.create_break_ix(&keeper.pubkey(), params());
    let meta = send(&mut env.svm, &keeper, &[], &[i]).unwrap();

    // 10 paid spots topped up by $5 each, 2 free spots at the full $25.
    assert_eq!(env.locked(), (50 * USDC, 50 * USDC));
    let b = env.brk(0);
    assert_eq!(b.status, BreakStatus::Open);
    assert_eq!((b.paid_spots, b.free_spots, b.spot_price), (10, 2, 20 * USDC));
    assert_eq!(
        (b.tier_count, b.tiers[0], b.pack_prices()),
        (1, tier(7, 25), vec![25 * USDC; 12])
    );
    assert_eq!((b.opens_at, b.closes_at), (T0, T0 + 6 * HOUR));
    assert_eq!(
        (b.locked_subsidy, b.locked_holder, b.spots_sold),
        (50 * USDC, 50 * USDC, 0)
    );
    assert_eq!(env.config().next_break_id, 1);

    let escrow = get_spl_account::<TokenAccountState>(&env.svm, &escrow_pda(&break_pda(0))).unwrap();
    assert_eq!((escrow.mint, escrow.owner, escrow.amount), (env.mint, break_pda(0), 0));
    // Creating a break moves no tokens, it only reserves them.
    assert_eq!(
        (env.balance(&subsidy_vault()), env.balance(&holder_vault())),
        (700 * USDC, 300 * USDC)
    );

    let event: BreakCreated = find_event(&meta.logs).expect("BreakCreated event");
    assert_eq!(
        (event.id, event.locked_subsidy, event.locked_holder),
        (0, 50 * USDC, 50 * USDC)
    );
}

#[test]
fn only_the_keeper_can_create_a_break() {
    let mut env = Env::ready();
    let admin = env.admin.insecure_clone();
    let i = env.create_break_ix(&admin.pubkey(), params());
    assert_fails_with(send(&mut env.svm, &admin, &[], &[i]), code(BreaksError::Unauthorized));
    assert_eq!(env.config().next_break_id, 0);
}

#[test]
fn a_paused_program_creates_no_breaks() {
    let mut env = Env::ready();
    env.set_paused(true);
    assert_fails_with(env.create_break_with(params()), code(BreaksError::Paused));
    env.set_paused(false);
    env.create_break_with(params()).unwrap();
}

#[test]
fn create_break_rejects_bad_parameters() {
    let mut env = Env::ready();
    let cases: Vec<(&str, CreateBreakParams, BreaksError)> = vec![
        (
            "no paid spots",
            CreateBreakParams {
                paid_spots: 0,
                ..params()
            },
            BreaksError::InvalidSpotCounts,
        ),
        (
            "too many paid spots",
            CreateBreakParams {
                paid_spots: 21,
                ..params()
            },
            BreaksError::InvalidSpotCounts,
        ),
        (
            "too many free spots",
            CreateBreakParams {
                free_spots: 7,
                ..params()
            },
            BreaksError::InvalidSpotCounts,
        ),
        (
            "free spot price",
            CreateBreakParams {
                spot_price: 0,
                ..params()
            },
            BreaksError::InvalidPrice,
        ),
        (
            "free packs",
            CreateBreakParams {
                tiers: vec![tier(7, 0)],
                ..params()
            },
            BreaksError::InvalidPrice,
        ),
        (
            "spot above pack price",
            CreateBreakParams {
                spot_price: 26 * USDC,
                ..params()
            },
            BreaksError::SpotPriceAboveAveragePack,
        ),
        (
            "no tiers",
            CreateBreakParams {
                tiers: vec![],
                ..params()
            },
            BreaksError::InvalidPackList,
        ),
        (
            "nine tiers",
            CreateBreakParams {
                tiers: (1..=9).map(|d| tier(d as u8, 20 + d)).collect(),
                packs: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8],
                ..params()
            },
            BreaksError::InvalidPackList,
        ),
        (
            "one pack too few",
            CreateBreakParams {
                packs: vec![0; 11],
                ..params()
            },
            BreaksError::InvalidPackList,
        ),
        (
            "one pack too many",
            CreateBreakParams {
                packs: vec![0; 13],
                ..params()
            },
            BreaksError::InvalidPackList,
        ),
        (
            "a pack names a tier that is not listed",
            CreateBreakParams {
                packs: [vec![0; 11], vec![1]].concat(),
                ..params()
            },
            BreaksError::InvalidPackList,
        ),
        (
            "a tier nobody uses",
            CreateBreakParams {
                tiers: vec![tier(7, 25), tier(8, 30)],
                ..params()
            },
            BreaksError::InvalidPackList,
        ),
        (
            "expensive packs first",
            CreateBreakParams {
                tiers: vec![tier(7, 25), tier(8, 30)],
                packs: [vec![1], vec![0; 11]].concat(),
                ..params()
            },
            BreaksError::InvalidPackList,
        ),
        (
            "window too short",
            CreateBreakParams {
                closes_at: T0 + 6 * HOUR - 1,
                ..params()
            },
            BreaksError::InvalidWindow,
        ),
        (
            "window too long",
            CreateBreakParams {
                closes_at: T0 + 24 * HOUR + 1,
                ..params()
            },
            BreaksError::InvalidWindow,
        ),
        (
            "closes before it opens",
            CreateBreakParams {
                closes_at: T0 - HOUR,
                ..params()
            },
            BreaksError::InvalidWindow,
        ),
        (
            "already over",
            CreateBreakParams {
                opens_at: T0 - 7 * HOUR,
                closes_at: T0 - 1,
                ..params()
            },
            BreaksError::InvalidWindow,
        ),
    ];
    for (name, p, expected) in cases {
        assert_fails_with_ctx(env.create_break_with(p), code(expected), name);
    }
    assert_eq!(env.config().next_break_id, 0);
    assert_eq!(env.locked(), (0, 0));
}

#[test]
fn create_break_fails_when_either_bucket_cannot_cover_the_worst_case() {
    let mut env = Env::ready();
    // Subsidy: 20 spots topped up by $40 = $800 > $700 available.
    let too_much_subsidy = uniform(20, 0, 10, 50);
    assert_fails_with(
        env.create_break_with(too_much_subsidy),
        treasury_code(TreasuryError::InsufficientAvailable),
    );
    // Holder: 6 free packs of $60 = $360 > $300 available.
    let too_much_holder = uniform(10, 6, 60, 60);
    assert_fails_with(
        env.create_break_with(too_much_holder),
        treasury_code(TreasuryError::InsufficientAvailable),
    );
    // A failed creation leaves no trace.
    assert_eq!(env.config().next_break_id, 0);
    assert_eq!(env.locked(), (0, 0));
}

#[test]
fn two_breaks_cannot_reserve_the_same_money() {
    let mut env = Env::ready();
    // Each of these locks $300 of subsidy: 20 spots x ($25 - $10).
    let big = uniform(20, 0, 10, 25);
    env.create_break_with(big.clone()).unwrap();
    env.create_break_with(big.clone()).unwrap();
    assert_eq!(env.locked(), (600 * USDC, 0));
    // Only $100 of subsidy is left, not enough for a third.
    assert_fails_with(
        env.create_break_with(big),
        treasury_code(TreasuryError::InsufficientAvailable),
    );
    // A smaller one still fits: 5 spots x $15 = $75.
    env.create_break_with(uniform(5, 0, 10, 25)).unwrap();
    assert_eq!(env.locked(), (675 * USDC, 0));
    assert_eq!(env.config().next_break_id, 3);
}

// ---------------------------------------------------------------- buy_spot

#[test]
fn buy_spot_moves_the_price_into_escrow_and_records_the_spot() {
    let mut env = Env::ready();
    let id = env.create_break();
    let (alice, alice_usdc) = env.user(50 * USDC);
    let i = ix(
        breaks::ID,
        breaks::accounts::BuySpot {
            buyer: alice.pubkey(),
            config: breaks_config(),
            break_: break_pda(id),
            escrow: escrow_pda(&break_pda(id)),
            buyer_usdc: alice_usdc,
            spot: spot_pda(&break_pda(id), 0),
            token_program: litesvm_token::TOKEN_ID,
            system_program: anchor_lang::system_program::ID,
        },
        breaks::instruction::BuySpot { index: 0 },
    );
    let meta = send(&mut env.svm, &alice, &[], &[i]).unwrap();

    assert_eq!(env.balance(&alice_usdc), 30 * USDC);
    assert_eq!(env.balance(&escrow_pda(&break_pda(id))), 20 * USDC);
    assert_eq!(env.brk(id).spots_sold, 1);
    let spot: Spot = env.read(&spot_pda(&break_pda(id), 0));
    assert_eq!(
        (spot.break_id, spot.index, spot.owner, spot.paid, spot.refunded),
        (id, 0, alice.pubkey(), 20 * USDC, false)
    );
    let event: SpotBought = find_event(&meta.logs).expect("SpotBought event");
    assert_eq!((event.index, event.owner, event.paid), (0, alice.pubkey(), 20 * USDC));
}

#[test]
fn one_wallet_can_hold_several_spots() {
    let mut env = Env::ready();
    let id = env.create_break();
    let (alice, alice_usdc) = env.user(100 * USDC);
    for index in 0..3 {
        env.buy_spot(&alice, alice_usdc, id, index).unwrap();
    }
    assert_eq!(env.brk(id).spots_sold, 3);
    assert_eq!(env.balance(&alice_usdc), 40 * USDC);
}

#[test]
fn spots_must_be_bought_in_order_and_only_once() {
    let mut env = Env::ready();
    let id = env.create_break();
    let (alice, alice_usdc) = env.user(100 * USDC);
    assert_fails_with(
        env.buy_spot(&alice, alice_usdc, id, 1),
        code(BreaksError::WrongSpotIndex),
    );
    env.buy_spot(&alice, alice_usdc, id, 0).unwrap();
    // Replaying index 0 hits the account that already exists.
    assert!(env.buy_spot(&alice, alice_usdc, id, 0).is_err());
    assert_eq!((env.brk(id).spots_sold, env.balance(&alice_usdc)), (1, 80 * USDC));
}

#[test]
fn spots_are_sold_only_inside_the_window() {
    let mut env = Env::ready();
    // Opens in one hour.
    env.create_break_with(CreateBreakParams {
        opens_at: T0 + HOUR,
        closes_at: T0 + 7 * HOUR,
        ..params()
    })
    .unwrap();
    let (alice, alice_usdc) = env.user(100 * USDC);
    assert_fails_with(
        env.buy_spot(&alice, alice_usdc, 0, 0),
        code(BreaksError::NotInSaleWindow),
    );
    set_unix_time(&mut env.svm, T0 + HOUR);
    env.buy_spot(&alice, alice_usdc, 0, 0).unwrap();
    set_unix_time(&mut env.svm, T0 + 7 * HOUR);
    assert_fails_with(
        env.buy_spot(&alice, alice_usdc, 0, 1),
        code(BreaksError::NotInSaleWindow),
    );
}

#[test]
fn a_sold_out_break_takes_no_more_spots() {
    let mut env = Env::ready();
    env.create_break_with(uniform(2, 2, 20, 25)).unwrap();
    let (alice, alice_usdc) = env.user(100 * USDC);
    env.buy_spot(&alice, alice_usdc, 0, 0).unwrap();
    env.buy_spot(&alice, alice_usdc, 0, 1).unwrap();
    assert_fails_with(env.buy_spot(&alice, alice_usdc, 0, 2), code(BreaksError::SoldOut));
}

#[test]
fn a_paused_program_sells_no_spots() {
    let mut env = Env::ready();
    let id = env.create_break();
    let (alice, alice_usdc) = env.user(100 * USDC);
    env.set_paused(true);
    assert_fails_with(env.buy_spot(&alice, alice_usdc, id, 0), code(BreaksError::Paused));
    env.set_paused(false);
    env.buy_spot(&alice, alice_usdc, id, 0).unwrap();
}

#[test]
fn buying_needs_your_own_usdc_account_with_enough_in_it() {
    let mut env = Env::ready();
    let id = env.create_break();
    let (alice, _alice_usdc) = env.user(100 * USDC);
    let (_bob, bob_usdc) = env.user(100 * USDC);
    assert_fails_with(
        env.buy_spot(&alice, bob_usdc, id, 0),
        ErrorCode::ConstraintTokenOwner as u32,
    );

    let (broke, broke_usdc) = env.user(19 * USDC);
    assert!(env.buy_spot(&broke, broke_usdc, id, 0).is_err());
    assert_eq!((env.brk(id).spots_sold, env.balance(&broke_usdc)), (0, 19 * USDC));
}

// ---------------------------------------------------------------- close_break

#[test]
fn anyone_can_close_a_break_but_only_after_the_deadline() {
    let mut env = Env::ready();
    let id = env.create_break();
    let (alice, alice_usdc) = env.user(100 * USDC);
    env.buy_spot(&alice, alice_usdc, id, 0).unwrap();
    let (stranger, _) = env.user(0);

    assert_fails_with(env.close(&stranger, id), code(BreaksError::TooEarlyToClose));
    set_unix_time(&mut env.svm, T0 + 6 * HOUR - 1);
    assert_fails_with(env.close(&stranger, id), code(BreaksError::TooEarlyToClose));

    env.after_deadline();
    let meta = env.close(&stranger, id).unwrap();
    assert_eq!(env.brk(id).status, BreakStatus::Closed);
    let event: BreakClosed = find_event(&meta.logs).expect("BreakClosed event");
    assert_eq!((event.id, event.spots_sold), (id, 1));

    assert_fails_with(env.close(&stranger, id), code(BreaksError::WrongStatus));
    assert_fails_with(env.buy_spot(&alice, alice_usdc, id, 1), code(BreaksError::WrongStatus));
}

// ---------------------------------------------------------------- commit_eligibility

#[test]
fn eligibility_is_committed_by_the_keeper_after_the_break_closes() {
    let mut env = Env::ready();
    let id = env.create_break();
    let keeper = env.keeper.insecure_clone();
    let (stranger, _) = env.user(0);

    assert_fails_with(env.commit_eligibility(id, 1_000, 5), code(BreaksError::WrongStatus)); // still open
    env.after_deadline();
    env.close(&stranger, id).unwrap();

    assert_fails_with(
        env.commit_eligibility_as(&stranger, id, 1_000, 5),
        code(BreaksError::Unauthorized),
    );
    assert_fails_with(env.commit_eligibility(id, 0, 5), code(BreaksError::InvalidEligibility));
    assert_fails_with(
        env.commit_eligibility(id, 1_000, 0),
        code(BreaksError::InvalidEligibility),
    );

    let meta = env.commit_eligibility_as(&keeper, id, 1_000, 5).unwrap();
    let b = env.brk(id);
    assert_eq!(b.status, BreakStatus::EligibilityCommitted);
    assert_eq!(
        (
            b.eligibility_root,
            b.eligibility_total_weight,
            b.eligibility_count,
            b.eligibility_inputs_hash
        ),
        ([1; 32], 1_000, 5, [2; 32])
    );
    let event: EligibilityCommitted = find_event(&meta.logs).expect("EligibilityCommitted event");
    assert_eq!((event.total_weight, event.entry_count), (1_000, 5));

    // Final: it cannot be replaced.
    assert_fails_with(env.commit_eligibility(id, 2_000, 6), code(BreaksError::WrongStatus));
}

// ---------------------------------------------------------------- fund_purchases

#[test]
fn funding_a_partly_filled_break_pays_exactly_the_packs_that_will_be_bought() {
    let mut env = Env::ready();
    // 3 of 10 spots sold; 1 eligible holder for 2 free spots -> 4 packs.
    let (id, _buyers) = closed_with(&mut env, 3, 1);
    assert_eq!(env.locked(), (50 * USDC, 50 * USDC));

    let meta = env.fund(id).unwrap();

    // Buyer wallet gets 4 x $25 = $100: $60 from escrow, 3 x $5 from subsidy, 1 x $25 from holder.
    assert_eq!(env.balance(&env.buyer_usdc), 100 * USDC);
    assert_eq!(env.balance(&escrow_pda(&break_pda(id))), 0);
    assert_eq!(env.balance(&subsidy_vault()), 685 * USDC);
    assert_eq!(env.balance(&holder_vault()), 275 * USDC);
    // Everything that was not needed is unlocked again.
    assert_eq!(env.locked(), (0, 0));
    let b = env.brk(id);
    assert_eq!(
        (b.status, b.pool_size, b.pack_budget, b.locked_subsidy, b.locked_holder),
        (BreakStatus::Funded, 4, 100 * USDC, 0, 0)
    );

    let event: PurchasesFunded = find_event(&meta.logs).expect("PurchasesFunded event");
    assert_eq!(
        (
            event.pool_size,
            event.from_escrow,
            event.from_subsidy,
            event.from_holder
        ),
        (4, 60 * USDC, 15 * USDC, 25 * USDC)
    );
    assert_eq!((event.unlocked_subsidy, event.unlocked_holder), (35 * USDC, 25 * USDC));
}

#[test]
fn funding_a_full_break_uses_the_whole_reservation() {
    let mut env = Env::ready();
    let (id, _buyers) = closed_with(&mut env, 10, 50);
    env.fund(id).unwrap();
    assert_eq!(env.balance(&env.buyer_usdc), 300 * USDC); // 12 packs
    assert_eq!(
        (env.balance(&subsidy_vault()), env.balance(&holder_vault())),
        (650 * USDC, 250 * USDC)
    );
    assert_eq!(env.locked(), (0, 0));
    assert_eq!(env.brk(id).pool_size, 12);
}

// ---- packs of different prices in one break

#[test]
fn a_mixed_break_locks_by_the_average_pack_price() {
    let mut env = Env::ready();
    let keeper = env.keeper.insecure_clone();
    let i = env.create_break_ix(&keeper.pubkey(), mixed());
    let meta = send(&mut env.svm, &keeper, &[], &[i]).unwrap();

    // $190 of packs over 8 spots is $23.75 each. The 2 free spots are $47.50 from the holder bucket; the 6 paid spots
    // bring in $120, so the subsidy bucket reserves the remaining $22.50.
    assert_eq!(env.locked(), (22_500_000, 47_500_000));
    let b = env.brk(0);
    assert_eq!(b.tier_count, 3);
    assert_eq!(b.tiers[..3], [tier(1, 10), tier(2, 25), tier(3, 50)]);
    assert_eq!(b.tiers[3..], [PackTier::default(); 5]);
    assert_eq!(b.pack_prices(), [10, 10, 10, 10, 25, 25, 50, 50].map(|d| d * USDC));
    assert_eq!(b.packs[8..], [0u8; 56]);
    assert_eq!((b.locked_subsidy, b.locked_holder), (22_500_000, 47_500_000));

    let event: BreakCreated = find_event(&meta.logs).expect("BreakCreated event");
    assert_eq!(event.tiers, vec![tier(1, 10), tier(2, 25), tier(3, 50)]);
    assert_eq!(event.packs, vec![0, 0, 0, 0, 1, 1, 2, 2]);
    assert_eq!((event.locked_subsidy, event.locked_holder), (22_500_000, 47_500_000));
}

#[test]
fn a_full_mixed_break_buys_every_pack() {
    let mut env = Env::ready();
    let (id, _buyers) = mixed_closed(&mut env, 6, 5);
    let meta = env.fund(id).unwrap();

    // All 8 packs: $190, of which the buyers paid $120 and the two buckets $22.50 and $47.50.
    assert_eq!(env.balance(&env.buyer_usdc), 190 * USDC);
    assert_eq!(env.balance(&escrow_pda(&break_pda(id))), 0);
    assert_eq!(env.balance(&subsidy_vault()), 700 * USDC - 22_500_000);
    assert_eq!(env.balance(&holder_vault()), 300 * USDC - 47_500_000);
    assert_eq!(env.locked(), (0, 0));
    let b = env.brk(id);
    assert_eq!(
        (b.status, b.pool_size, b.pack_budget),
        (BreakStatus::Funded, 8, 190 * USDC)
    );

    let event: PurchasesFunded = find_event(&meta.logs).expect("PurchasesFunded event");
    assert_eq!(
        (event.from_escrow, event.from_subsidy, event.from_holder),
        (120 * USDC, 22_500_000, 47_500_000)
    );
    assert_eq!((event.unlocked_subsidy, event.unlocked_holder), (0, 0));
}

#[test]
fn a_mixed_break_that_does_not_fill_drops_its_most_expensive_packs() {
    let mut env = Env::ready();
    // All 6 paid spots sold but only 1 eligible holder: 7 packs, so one of the two $50 packs is not bought.
    // $10 x 4 + $25 x 2 + $50 = $140, which is exactly $20 a pack: the spot price.
    let (id, _buyers) = mixed_closed(&mut env, 6, 1);
    let meta = env.fund(id).unwrap();

    assert_eq!(env.balance(&env.buyer_usdc), 140 * USDC);
    // The buyers' $120 and $20 from the holder bucket; the subsidy bucket is not needed at all.
    assert_eq!(env.balance(&subsidy_vault()), 700 * USDC);
    assert_eq!(env.balance(&holder_vault()), 280 * USDC);
    assert_eq!(env.locked(), (0, 0));
    let b = env.brk(id);
    assert_eq!((b.pool_size, b.pack_budget), (7, 140 * USDC));

    let event: PurchasesFunded = find_event(&meta.logs).expect("PurchasesFunded event");
    assert_eq!(
        (event.from_escrow, event.from_subsidy, event.from_holder),
        (120 * USDC, 0, 20 * USDC)
    );
    assert_eq!(
        (event.unlocked_subsidy, event.unlocked_holder),
        (22_500_000, 27_500_000)
    );
}

#[test]
fn a_break_whose_packs_are_worth_less_than_its_spots_is_cancelled_and_refunded() {
    let mut env = Env::ready();
    // Only 4 spots sold: with the 2 free spots the pool is the 6 cheapest packs, $90 or $15 each, for spots that cost $20.
    let (id, buyers) = mixed_closed(&mut env, 4, 5);
    assert_fails_with(env.fund(id), code(BreaksError::PacksWorthLessThanSpots));
    assert_eq!(env.brk(id).status, BreakStatus::EligibilityCommitted);
    assert_eq!(env.balance(&env.buyer_usdc), 0);
    assert_eq!(env.locked(), (22_500_000, 47_500_000));

    // The admin cancels, the reservation is released and every buyer gets the whole $20 back.
    env.cancel(id).unwrap();
    assert_eq!(env.locked(), (0, 0));
    let (anyone, _) = env.user(0);
    for (index, (_, usdc)) in buyers.iter().enumerate() {
        env.refund(&anyone, id, index as u16, *usdc).unwrap();
        assert_eq!(env.balance(usdc), 20 * USDC);
    }
    assert_eq!(env.balance(&escrow_pda(&break_pda(id))), 0);
}

#[test]
fn a_break_with_only_free_spots_is_paid_by_the_holder_bucket() {
    let mut env = Env::ready();
    let (id, _) = closed_with(&mut env, 0, 10);
    env.fund(id).unwrap();
    assert_eq!(env.balance(&env.buyer_usdc), 50 * USDC); // 2 free packs
    assert_eq!(
        (env.balance(&subsidy_vault()), env.balance(&holder_vault())),
        (700 * USDC, 250 * USDC)
    );
}

#[test]
fn a_break_nobody_joined_cannot_be_funded_and_is_cancelled_instead() {
    let mut env = Env::ready();
    let (id, _) = closed_with(&mut env, 0, 0);
    assert_fails_with(env.fund(id), code(BreaksError::EmptyPool));
    assert_eq!(env.balance(&env.buyer_usdc), 0);
    env.cancel(id).unwrap();
    assert_eq!(env.locked(), (0, 0));
}

#[test]
fn funding_follows_the_state_machine_and_the_keeper_role() {
    let mut env = Env::ready();
    let id = env.create_break();
    let (stranger, _) = env.user(0);
    assert_fails_with(env.fund(id), code(BreaksError::WrongStatus)); // still open

    env.sell_one(id);
    env.after_deadline();
    env.close(&stranger, id).unwrap();
    assert_fails_with(env.fund(id), code(BreaksError::WrongStatus)); // eligibility not committed yet
    env.commit_eligibility(id, 1_000, 5).unwrap();

    let i = env.fund_ix(&stranger.pubkey(), id, env.buyer_usdc);
    assert_fails_with(
        send(&mut env.svm, &stranger, &[], &[i]),
        code(BreaksError::Unauthorized),
    );

    env.fund(id).unwrap();
    assert_fails_with(env.fund(id), code(BreaksError::WrongStatus)); // never twice
    assert_eq!(env.balance(&env.buyer_usdc), 75 * USDC); // 1 paid + 2 free packs
}

#[test]
fn the_pack_budget_can_only_go_to_the_buyer_wallet() {
    let mut env = Env::ready();
    let (id, _) = closed_with(&mut env, 2, 5);
    let keeper = env.keeper.insecure_clone();
    let (_thief, thief_usdc) = env.user(0);
    // A compromised keeper cannot redirect the money to its own account.
    let i = env.fund_ix(&keeper.pubkey(), id, thief_usdc);
    assert_fails_with(
        send(&mut env.svm, &keeper, &[], &[i]),
        ErrorCode::ConstraintTokenOwner as u32,
    );
    assert_eq!(env.balance(&thief_usdc), 0);
    assert_eq!(env.brk(id).status, BreakStatus::EligibilityCommitted);
}

#[test]
fn a_paused_program_does_not_pay_out_the_pack_budget() {
    let mut env = Env::ready();
    let (id, _) = closed_with(&mut env, 2, 3);
    env.set_paused(true);
    assert_fails_with(env.fund(id), code(BreaksError::Paused));
    assert_eq!(env.balance(&env.buyer_usdc), 0);
    // The admin can still unwind the break, and funding works again after unpausing.
    env.set_paused(false);
    env.fund(id).unwrap();
    assert_eq!(env.balance(&env.buyer_usdc), 100 * USDC);
}

// ---------------------------------------------------------------- commit_pool

#[test]
fn the_pool_is_committed_once_after_funding_with_the_funded_size() {
    let mut env = Env::ready();
    let (id, _) = closed_with(&mut env, 3, 1);
    let keeper = env.keeper.insecure_clone();
    let (stranger, _) = env.user(0);

    assert_fails_with(env.commit_pool_as(&keeper, id, 4), code(BreaksError::WrongStatus)); // not funded yet
    env.fund(id).unwrap();
    assert_fails_with(env.commit_pool_as(&stranger, id, 4), code(BreaksError::Unauthorized));
    assert_fails_with(env.commit_pool_as(&keeper, id, 3), code(BreaksError::PoolSizeMismatch));
    assert_fails_with(env.commit_pool_as(&keeper, id, 5), code(BreaksError::PoolSizeMismatch));

    let meta = env.commit_pool_as(&keeper, id, 4).unwrap();
    let b = env.brk(id);
    assert_eq!((b.status, b.pool_hash), (BreakStatus::PoolCommitted, [3; 32]));
    let event: PoolCommitted = find_event(&meta.logs).expect("PoolCommitted event");
    assert_eq!((event.pool_hash, event.pool_size), ([3; 32], 4));
    assert_fails_with(env.commit_pool_as(&keeper, id, 4), code(BreaksError::WrongStatus));
}

// ---------------------------------------------------------------- cancel_break and refunds

#[test]
fn a_cancelled_break_unlocks_the_treasury_and_refunds_every_buyer() {
    let mut env = Env::ready();
    let id = env.create_break();
    let buyers: Vec<_> = (0..3).map(|_| env.sell_one(id)).collect();
    assert_eq!(env.balance(&escrow_pda(&break_pda(id))), 60 * USDC);
    let (stranger, _) = env.user(0);

    let meta = env.cancel(id).unwrap();
    assert_eq!(env.brk(id).status, BreakStatus::Cancelled);
    assert_eq!(env.locked(), (0, 0));
    let event: BreakCancelled = find_event(&meta.logs).expect("BreakCancelled event");
    assert_eq!((event.id, event.spots_sold), (id, 3));

    // A stranger pays the fee, the money still goes to the owner.
    for (index, (_, usdc)) in buyers.iter().enumerate() {
        assert_eq!(env.balance(usdc), 0);
        let meta = env.refund(&stranger, id, index as u16, *usdc).unwrap();
        assert_eq!(env.balance(usdc), 20 * USDC);
        let event: SpotRefunded = find_event(&meta.logs).expect("SpotRefunded event");
        assert_eq!((event.index, event.amount), (index as u16, 20 * USDC));
    }
    assert_eq!(env.balance(&escrow_pda(&break_pda(id))), 0);
}

#[test]
fn a_spot_is_refunded_once_and_only_to_its_owner() {
    let mut env = Env::ready();
    let id = env.create_break();
    let (_alice, alice_usdc) = env.sell_one(id);
    let (_bob, bob_usdc) = env.sell_one(id);
    let (stranger, stranger_usdc) = env.user(0);

    assert_fails_with(env.refund(&stranger, id, 0, alice_usdc), code(BreaksError::WrongStatus)); // not cancelled
    env.cancel(id).unwrap();

    assert_fails_with(
        env.refund(&stranger, id, 0, stranger_usdc),
        ErrorCode::ConstraintTokenOwner as u32,
    );
    assert_fails_with(
        env.refund(&stranger, id, 0, bob_usdc),
        ErrorCode::ConstraintTokenOwner as u32,
    );
    env.refund(&stranger, id, 0, alice_usdc).unwrap();
    assert_fails_with(
        env.refund(&stranger, id, 0, alice_usdc),
        code(BreaksError::AlreadyRefunded),
    );
    assert_eq!(env.balance(&alice_usdc), 20 * USDC);
    assert_eq!(env.balance(&stranger_usdc), 0);
}

#[test]
fn cancelling_is_admin_only_and_works_in_every_status_before_funding() {
    let mut env = Env::ready();
    let keeper = env.keeper.insecure_clone();
    let (stranger, _) = env.user(0);

    // Open
    let open = env.create_break();
    assert_fails_with(env.cancel_as(&keeper, open), code(BreaksError::Unauthorized));
    assert_fails_with(env.cancel_as(&stranger, open), code(BreaksError::Unauthorized));
    env.cancel(open).unwrap();
    assert_fails_with(env.cancel(open), code(BreaksError::WrongStatus)); // not twice

    // Closed
    let closed = env
        .create_break_with(params())
        .map(|_| env.config().next_break_id - 1)
        .unwrap();
    env.sell_one(closed);
    env.after_deadline();
    env.close(&stranger, closed).unwrap();
    env.cancel(closed).unwrap();

    // EligibilityCommitted
    set_unix_time(&mut env.svm, T0);
    let committed = env
        .create_break_with(CreateBreakParams {
            opens_at: T0,
            closes_at: T0 + 6 * HOUR,
            ..params()
        })
        .map(|_| env.config().next_break_id - 1)
        .unwrap();
    env.sell_one(committed);
    env.after_deadline();
    env.close(&stranger, committed).unwrap();
    env.commit_eligibility(committed, 1_000, 3).unwrap();
    env.cancel(committed).unwrap();

    assert_eq!(env.locked(), (0, 0));
}

// ---------------------------------------------------------------- cancel_unfundable: anyone, for a break nobody can fund

#[test]
fn anyone_can_cancel_a_break_whose_packs_are_worth_less_than_its_spots() {
    let mut env = Env::ready();
    // 4 spots sold at $20 and 2 free spots: the 6 cheapest packs cost $90 in all, $15 each.
    let (id, buyers) = mixed_closed(&mut env, 4, 5);
    assert_fails_with(env.fund(id), code(BreaksError::PacksWorthLessThanSpots));
    assert_eq!(env.locked(), (22_500_000, 47_500_000));

    // A stranger, who is neither the admin nor the keeper, sends it.
    let (stranger, _) = env.user(0);
    let meta = env.cancel_unfundable_as(&stranger, id).unwrap();
    assert_eq!(env.brk(id).status, BreakStatus::Cancelled);
    assert_eq!((env.brk(id).locked_subsidy, env.brk(id).locked_holder), (0, 0));
    assert_eq!(env.locked(), (0, 0));
    let event: BreakCancelled = find_event(&meta.logs).expect("BreakCancelled event");
    assert_eq!((event.id, event.spots_sold), (id, 4));
    // The treasury got back what it had reserved and paid nothing out.
    assert_eq!(
        (env.balance(&subsidy_vault()), env.balance(&holder_vault())),
        (700 * USDC, 300 * USDC)
    );
    assert_eq!(env.balance(&env.buyer_usdc), 0);

    // Funding is no longer possible, and every buyer takes the whole $20 back.
    assert_fails_with(env.fund(id), code(BreaksError::WrongStatus));
    for (index, (_, usdc)) in buyers.iter().enumerate() {
        env.refund(&stranger, id, index as u16, *usdc).unwrap();
        assert_eq!(env.balance(usdc), 20 * USDC);
    }
    assert_eq!(env.balance(&escrow_pda(&break_pda(id))), 0);
}

#[test]
fn anyone_can_cancel_a_break_nobody_joined() {
    let mut env = Env::ready();
    let (id, _) = closed_with(&mut env, 0, 0);
    assert_fails_with(env.fund(id), code(BreaksError::EmptyPool));
    let (stranger, _) = env.user(0);
    env.cancel_unfundable_as(&stranger, id).unwrap();
    assert_eq!(env.brk(id).status, BreakStatus::Cancelled);
    assert_eq!(env.locked(), (0, 0));
    assert_fails_with(env.cancel_unfundable_as(&stranger, id), code(BreaksError::WrongStatus));
    // not twice
}

#[test]
fn a_break_that_can_be_funded_is_not_anyones_to_cancel() {
    let mut env = Env::ready();
    let (stranger, _) = env.user(0);
    let keeper = env.keeper.insecure_clone();

    // Full: every pack is bought.
    let (full, _) = mixed_closed(&mut env, 6, 5);
    assert_fails_with(
        env.cancel_unfundable_as(&stranger, full),
        code(BreaksError::BreakIsFundable),
    );
    assert_fails_with(
        env.cancel_unfundable_as(&keeper, full),
        code(BreaksError::BreakIsFundable),
    );
    assert_eq!(env.brk(full).status, BreakStatus::EligibilityCommitted);
    assert_eq!(env.locked(), (22_500_000, 47_500_000));

    // The edge: 6 sold and 1 holder, 7 packs of $140 in all, exactly $20 each, the spot price. Fundable, so not cancellable.
    set_unix_time(&mut env.svm, T0); // the next break's window starts again at T0
    let (edge, _) = mixed_closed(&mut env, 6, 1);
    assert_fails_with(
        env.cancel_unfundable_as(&stranger, edge),
        code(BreaksError::BreakIsFundable),
    );
    env.fund(edge).unwrap();
    // Both can be funded, which is the point.
    env.fund(full).unwrap();
}

#[test]
fn the_admin_can_still_cancel_a_break_that_could_be_funded() {
    let mut env = Env::ready();
    let (id, _) = mixed_closed(&mut env, 6, 5);
    assert_fails_with(
        env.cancel_unfundable_as(&env.keeper.insecure_clone(), id),
        code(BreaksError::BreakIsFundable),
    );
    env.cancel(id).unwrap();
    assert_eq!(env.brk(id).status, BreakStatus::Cancelled);
}

#[test]
fn cancel_unfundable_only_works_once_the_eligibility_list_is_committed() {
    let mut env = Env::ready();
    let (stranger, _) = env.user(0);

    // Open: the sale is still running.
    let open = env.create_break();
    assert_fails_with(
        env.cancel_unfundable_as(&stranger, open),
        code(BreaksError::WrongStatus),
    );

    // Closed, the eligibility list not committed yet: nobody knows how many holders there are.
    env.sell_one(open);
    env.after_deadline();
    env.close(&stranger, open).unwrap();
    assert_fails_with(
        env.cancel_unfundable_as(&stranger, open),
        code(BreaksError::WrongStatus),
    );
    env.cancel(open).unwrap();

    // Funded: the packs are paid for.
    set_unix_time(&mut env.svm, T0); // the next break's window starts again at T0
    let (funded, _) = closed_with(&mut env, 2, 3);
    env.fund(funded).unwrap();
    assert_fails_with(
        env.cancel_unfundable_as(&stranger, funded),
        code(BreaksError::WrongStatus),
    );
    // Pool committed too.
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, funded, 4).unwrap();
    assert_fails_with(
        env.cancel_unfundable_as(&stranger, funded),
        code(BreaksError::WrongStatus),
    );
}

#[test]
fn cancel_unfundable_works_while_the_program_is_paused() {
    let mut env = Env::ready();
    let (id, _) = mixed_closed(&mut env, 4, 5);
    env.set_paused(true);
    // Funding is stopped by the pause, and so would a refusal be, but cancelling and refunding always work.
    let (stranger, _) = env.user(0);
    env.cancel_unfundable_as(&stranger, id).unwrap();
    assert_eq!(env.brk(id).status, BreakStatus::Cancelled);
    assert_eq!(env.locked(), (0, 0));
}

#[test]
fn cancel_unfundable_agrees_with_fund_purchases_for_every_closed_shape() {
    // The mixed break: 6 paid spots at $20, 2 free spots, packs of $10 x 4, $25 x 2 and $50 x 2. For every number of spots sold and
    // holders eligible, the cancel anyone may send works exactly when funding would refuse, and a break it refuses is funded.
    let prices = [10u64, 10, 10, 10, 25, 25, 50, 50];
    let by_the_book = |sold: u64, eligible: u64| {
        let pool = sold + 2u64.min(eligible);
        pool == 0 || (sold > 0 && 20 > prices[..pool as usize].iter().sum::<u64>() / pool)
    };
    let mut env = Env::ready();
    let (stranger, _) = env.user(0);
    let (mut cancelled, mut funded) = (0, 0);
    for sold in 0..=6u16 {
        for eligible in 0..=3u32 {
            set_unix_time(&mut env.svm, T0); // every break's window starts at T0
            let (id, _) = mixed_closed(&mut env, sold, eligible);
            let result = env.cancel_unfundable_as(&stranger, id);
            if by_the_book(u64::from(sold), u64::from(eligible)) {
                result.unwrap_or_else(|e| panic!("{sold} sold, {eligible} eligible: should be cancellable, got {e:?}"));
                assert_eq!(
                    env.brk(id).status,
                    BreakStatus::Cancelled,
                    "{sold} sold, {eligible} eligible"
                );
                cancelled += 1;
            } else {
                assert_fails_with(result, code(BreaksError::BreakIsFundable));
                env.fund(id)
                    .unwrap_or_else(|e| panic!("{sold} sold, {eligible} eligible: should be fundable, got {e:?}"));
                funded += 1;
            }
            assert_eq!(env.locked(), (0, 0), "{sold} sold, {eligible} eligible");
        }
    }
    // Both kinds happened, so neither branch went untested.
    assert!(cancelled > 10 && funded >= 4, "{cancelled} cancelled, {funded} funded");
}

#[test]
fn a_funded_break_can_no_longer_be_cancelled() {
    let mut env = Env::ready();
    let (id, _) = closed_with(&mut env, 2, 3);
    env.fund(id).unwrap();
    assert_fails_with(env.cancel(id), code(BreaksError::WrongStatus));
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, id, 4).unwrap();
    assert_fails_with(env.cancel(id), code(BreaksError::WrongStatus));
}

#[test]
fn pausing_never_traps_anyones_money() {
    let mut env = Env::ready();
    let id = env.create_break();
    let (alice, alice_usdc) = env.sell_one(id);
    let _ = alice;
    env.set_paused(true);
    env.cancel(id).unwrap();
    let (stranger, _) = env.user(0);
    env.refund(&stranger, id, 0, alice_usdc).unwrap();
    assert_eq!(env.balance(&alice_usdc), 20 * USDC);
}

// ---------------------------------------------------------------- randomness

#[test]
fn randomness_is_only_requested_once_eligibility_and_the_pool_are_committed() {
    let mut env = Env::ready();
    let id = env.create_break();
    assert_fails_with(env.request_randomness(id), code(BreaksError::WrongStatus)); // open
    env.sell_one(id);
    env.after_deadline();
    let (anyone, _) = env.user(0);
    env.close(&anyone, id).unwrap();
    assert_fails_with(env.request_randomness(id), code(BreaksError::WrongStatus)); // closed
    env.commit_eligibility(id, 1_000, 5).unwrap();
    assert_fails_with(env.request_randomness(id), code(BreaksError::WrongStatus)); // no pool yet
    env.fund(id).unwrap();
    assert_fails_with(env.request_randomness(id), code(BreaksError::WrongStatus)); // funded, pool not committed
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, id, 3).unwrap();
    env.request_randomness(id).unwrap();
}

#[test]
fn a_request_goes_to_the_vrf_program_and_is_bound_to_the_commitments() {
    let mut env = Env::ready();
    let id = committed(&mut env);
    let before = (
        env.balance(&env.buyer_usdc),
        env.balance(&subsidy_vault()),
        env.balance(&holder_vault()),
    );

    let meta = env.request_randomness(id).unwrap();

    let b = env.brk(id);
    assert_eq!(
        (b.status, b.randomness_attempt, b.randomness_requested_at),
        (BreakStatus::RandomnessRequested, 0, T0 + 6 * HOUR)
    );

    // The id commits to the break, the attempt, the eligibility root and the pool hash.
    let expected = solana_sha256_hasher::hashv(&[
        b"breaks:randomness:v1",
        break_pda(id).as_ref(),
        &[0u8],
        &b.eligibility_root,
        &b.pool_hash,
    ])
    .to_bytes();
    assert_eq!(b.randomness_request_id, expected);

    // The VRF program created a pending request for exactly that seed.
    let request = env.request_for(&expected);
    let account = env.svm.get_account(&request).expect("request exists");
    assert_eq!(account.owner, mock_orao::ID);
    assert_eq!(parse_request(&account.data, &expected).unwrap(), RequestState::Pending);

    let event: RandomnessRequested = find_event(&meta.logs).expect("RandomnessRequested event");
    assert_eq!(
        (event.id, event.attempt, event.request_id, event.request),
        (id, 0, expected, request)
    );
    // Asking for randomness moves no money.
    assert_eq!(
        before,
        (
            env.balance(&env.buyer_usdc),
            env.balance(&subsidy_vault()),
            env.balance(&holder_vault())
        )
    );
}

#[test]
fn only_the_keeper_requests_randomness_and_only_once_per_attempt() {
    let mut env = Env::ready();
    let id = committed(&mut env);
    let (stranger, _) = env.user(0);
    let i = env.request_randomness_ix(&stranger.pubkey(), id, 0, anchor_lang::system_program::ID);
    assert_fails_with(
        send(&mut env.svm, &stranger, &[], &[i]),
        code(BreaksError::Unauthorized),
    );

    env.request_randomness(id).unwrap();
    // A second first-time request is rejected: the break is already waiting.
    assert_fails_with(env.request_randomness(id), code(BreaksError::RequestNotTimedOut));
}

#[test]
fn the_seed_is_locked_in_by_anyone_once_the_vrf_answers_and_never_changes() {
    let mut env = Env::ready();
    let id = committed(&mut env);
    env.request_randomness(id).unwrap();
    let rid = env.brk(id).randomness_request_id;

    assert_fails_with(env.settle(id), code(BreaksError::RandomnessNotFulfilled));
    env.mock_fulfill(rid, [42; 64]).unwrap();
    let meta = env.settle(id).unwrap();

    let b = env.brk(id);
    assert_eq!((b.status, b.seed), (BreakStatus::Settled, draw_seed(&[42; 64])));
    let event: RandomnessSettled = find_event(&meta.logs).expect("RandomnessSettled event");
    assert_eq!((event.id, event.seed), (id, draw_seed(&[42; 64])));

    // Final: settling again, requesting again, replacing the adapter's answer and cancelling all fail.
    assert_fails_with(env.settle(id), code(BreaksError::WrongStatus));
    assert_fails_with(env.request_randomness(id), code(BreaksError::WrongStatus));
    assert_fails_with(env.cancel(id), code(BreaksError::WrongStatus));
    assert!(env.mock_fulfill(rid, [7; 64]).is_err());
    assert_eq!(env.brk(id).seed, draw_seed(&[42; 64]));
}

#[test]
fn the_request_of_another_break_cannot_settle_this_one() {
    let mut env = Env::ready();
    let a = committed(&mut env);
    env.request_randomness(a).unwrap();
    env.after_deadline(); // same clock is fine; just make a second break
    let b = {
        set_unix_time(&mut env.svm, T0);
        let b = committed(&mut env);
        env.request_randomness(b).unwrap();
        b
    };
    let (rid_a, rid_b) = (env.brk(a).randomness_request_id, env.brk(b).randomness_request_id);
    assert_ne!(rid_a, rid_b);
    env.mock_fulfill(rid_a, [1; 64]).unwrap();
    env.mock_fulfill(rid_b, [2; 64]).unwrap();

    let (stranger, _) = env.user(0);
    let record_b = env.request_for(&rid_b);
    assert_fails_with(
        env.settle_with(&stranger, a, record_b),
        code(BreaksError::InvalidRandomnessRecord),
    );
    // Each settles with its own.
    env.settle(a).unwrap();
    env.settle(b).unwrap();
    assert_eq!(
        (env.brk(a).seed, env.brk(b).seed),
        (draw_seed(&[1; 64]), draw_seed(&[2; 64]))
    );
}

#[test]
fn a_forged_request_account_cannot_provide_the_seed() {
    let mut env = Env::ready();
    let id = committed(&mut env);
    env.request_randomness(id).unwrap();
    let rid = env.brk(id).randomness_request_id;
    let (stranger, _) = env.user(0);

    // A look-alike request account, "fulfilled" with a chosen value, in ORAO's exact layout.
    let mut data = vec![139, 239, 184, 215, 227, 86, 191, 226]; // RandomnessV2 discriminator
    data.push(1); // Fulfilled
    data.extend_from_slice(&[7; 32]); // client
    data.extend_from_slice(&rid); // seed
    data.extend_from_slice(&[99; 64]); // the answer the attacker wants
    assert_eq!(parse_request(&data, &rid).unwrap(), RequestState::Fulfilled([99; 64]));

    // (1) owned by someone other than the VRF program
    let at_right_address = env.request_for(&rid);
    let genuine = env.svm.get_account(&at_right_address).unwrap();
    let mut forged = genuine.clone();
    forged.owner = anchor_lang::system_program::ID;
    forged.data = data.clone();
    env.svm.set_account(at_right_address, forged).unwrap();
    assert_fails_with(
        env.settle_with(&stranger, id, at_right_address),
        code(BreaksError::InvalidRandomnessRecord),
    );
    env.svm.set_account(at_right_address, genuine).unwrap();

    // (2) owned by the VRF program but at an address it would not use for this seed
    let elsewhere = Address::new_unique();
    let mut look_alike = env.svm.get_account(&at_right_address).unwrap();
    look_alike.data = data;
    env.svm.set_account(elsewhere, look_alike).unwrap();
    assert_fails_with(
        env.settle_with(&stranger, id, elsewhere),
        code(BreaksError::InvalidRandomnessRecord),
    );

    // The genuine, still pending request keeps the break waiting.
    assert_fails_with(env.settle(id), code(BreaksError::RandomnessNotFulfilled));
    assert_eq!(env.brk(id).status, BreakStatus::RandomnessRequested);
}

#[test]
fn a_request_someone_else_already_made_for_the_same_seed_is_adopted_not_a_dead_end() {
    // The seed becomes computable once the commitments are on-chain, so anyone could ask the VRF
    // program for it first. That must not block the break: the answer is just as unpredictable.
    let mut env = Env::ready();
    let id = committed(&mut env);
    let seed = env.request_id_for(id, 0);
    env.squat_request(seed).unwrap();

    env.request_randomness(id).unwrap(); // does not fail, does not ask again
    let b = env.brk(id);
    assert_eq!(
        (b.status, b.randomness_request_id),
        (BreakStatus::RandomnessRequested, seed)
    );

    env.mock_fulfill(seed, [8; 64]).unwrap();
    env.settle(id).unwrap();
    assert_eq!(env.brk(id).seed, draw_seed(&[8; 64]));
}

#[test]
fn a_request_that_was_already_answered_before_the_keeper_asked_can_be_settled_right_away() {
    let mut env = Env::ready();
    let id = committed(&mut env);
    let seed = env.request_id_for(id, 0);
    env.squat_request(seed).unwrap();
    env.mock_fulfill(seed, [3; 64]).unwrap();

    env.request_randomness(id).unwrap();
    env.settle(id).unwrap();
    assert_eq!(env.brk(id).seed, draw_seed(&[3; 64]));
}

#[test]
fn an_unanswered_request_can_be_repeated_after_the_timeout_and_the_old_answer_is_ignored() {
    let mut env = Env::ready();
    let id = committed(&mut env);
    env.request_randomness(id).unwrap();
    let first = env.brk(id).randomness_request_id;

    assert_fails_with(env.repeat_randomness(id), code(BreaksError::RequestNotTimedOut));
    set_unix_time(&mut env.svm, T0 + 6 * HOUR + HOUR - 1);
    assert_fails_with(env.repeat_randomness(id), code(BreaksError::RequestNotTimedOut));
    set_unix_time(&mut env.svm, T0 + 6 * HOUR + HOUR);
    env.repeat_randomness(id).unwrap();

    let b = env.brk(id);
    assert_eq!((b.status, b.randomness_attempt), (BreakStatus::RandomnessRequested, 1));
    assert_ne!(b.randomness_request_id, first);
    assert_eq!(b.randomness_request_id, env.request_id_for(id, 1));

    // The vendor finally answers the OLD request: it is ignored.
    env.mock_fulfill(first, [1; 64]).unwrap();
    let (stranger, _) = env.user(0);
    let old_record = env.request_for(&first);
    assert_fails_with(
        env.settle_with(&stranger, id, old_record),
        code(BreaksError::InvalidRandomnessRecord),
    );
    assert_fails_with(env.settle(id), code(BreaksError::RandomnessNotFulfilled));

    env.mock_fulfill(b.randomness_request_id, [2; 64]).unwrap();
    env.settle(id).unwrap();
    assert_eq!(env.brk(id).seed, draw_seed(&[2; 64]));
}

#[test]
fn an_answered_request_must_be_settled_it_can_never_be_replaced() {
    let mut env = Env::ready();
    let id = committed(&mut env);
    env.request_randomness(id).unwrap();
    env.mock_fulfill(env.brk(id).randomness_request_id, [5; 64]).unwrap();

    // Even long after the timeout, a keeper cannot re-roll an answer it does not like.
    set_unix_time(&mut env.svm, T0 + 6 * HOUR + 10 * HOUR);
    assert_fails_with(env.repeat_randomness(id), code(BreaksError::AlreadyFulfilled));
    env.settle(id).unwrap();
    assert_eq!(env.brk(id).seed, draw_seed(&[5; 64]));
}

#[test]
fn a_repeat_must_present_the_previous_request_and_the_number_of_repeats_is_limited() {
    let mut env = Env::ready();
    let id = committed(&mut env);
    env.request_randomness(id).unwrap();
    let keeper = env.keeper.insecure_clone();

    // Hiding the previous request is not an option.
    set_unix_time(&mut env.svm, T0 + 7 * HOUR);
    let sneaky = env.request_randomness_ix(&keeper.pubkey(), id, 1, anchor_lang::system_program::ID);
    assert_fails_with(
        send(&mut env.svm, &keeper, &[], &[sneaky]),
        code(BreaksError::InvalidRandomnessRecord),
    );

    // Attempts 1..=4 are allowed, the sixth request is not.
    for attempt in 1..5u8 {
        set_unix_time(&mut env.svm, T0 + 6 * HOUR + HOUR * (i64::from(attempt) + 1));
        env.repeat_randomness(id).unwrap();
        assert_eq!(env.brk(id).randomness_attempt, attempt);
    }
    set_unix_time(&mut env.svm, T0 + 6 * HOUR + HOUR * 10);
    assert_fails_with(env.repeat_randomness(id), code(BreaksError::TooManyAttempts));
}

#[test]
fn only_the_admin_appoints_the_vrf_program_and_requests_go_only_to_it() {
    let mut env = Env::ready();
    let admin = env.admin.insecure_clone();
    let keeper = env.keeper.insecure_clone();
    assert_fails_with(
        env.admin_call(
            &keeper,
            breaks::instruction::SetRandomness {
                program: treasury::ID,
                timeout_secs: HOUR,
            },
        ),
        code(BreaksError::Unauthorized),
    );
    assert_fails_with(
        env.admin_call(
            &admin,
            breaks::instruction::SetRandomness {
                program: treasury::ID,
                timeout_secs: 0,
            },
        ),
        code(BreaksError::InvalidRandomnessConfig),
    );

    let id = committed(&mut env);
    // Appoint a different program: the mock is no longer accepted.
    env.admin_call(
        &admin,
        breaks::instruction::SetRandomness {
            program: treasury::ID,
            timeout_secs: 2 * HOUR,
        },
    )
    .unwrap();
    assert_eq!(
        (env.config().randomness_program, env.config().randomness_timeout_secs),
        (treasury::ID, 2 * HOUR)
    );
    assert_fails_with(env.request_randomness(id), code(BreaksError::InvalidRandomnessRecord));
    // Appointing the mock again works.
    env.admin_call(
        &admin,
        breaks::instruction::SetRandomness {
            program: mock_orao::ID,
            timeout_secs: HOUR,
        },
    )
    .unwrap();
    env.request_randomness(id).unwrap();
}

#[test]
fn initialize_rejects_a_zero_randomness_timeout() {
    let mut env = Env::base();
    let mut i = env.initialize_ix(&env.authority.pubkey(), env.breaks_programdata);
    i.data = breaks::instruction::Initialize {
        params: breaks::InitializeParams {
            admin: env.admin.pubkey(),
            keeper: env.keeper.pubkey(),
            buyer: env.buyer.pubkey(),
            min_window_secs: 6 * HOUR,
            max_window_secs: 24 * HOUR,
            max_paid_spots: 20,
            max_free_spots: 6,
            randomness_program: mock_orao::ID,
            randomness_timeout_secs: 0,
        },
    }
    .data();
    assert_fails_with(env.send_as_authority(&[i]), code(BreaksError::InvalidRandomnessConfig));
}

// ---------------------------------------------------------------- the draw

/// A break taken all the way to a final seed, with a real eligibility tree committed.
struct DrawSetup {
    id: u64,
    leaves: Vec<Leaf>,
    tree: Tree,
    /// The seed the program stored.
    seed: [u8; 32],
}

/// Creates a break (2 free spots), sells `sold` spots, commits `leaves` as the eligible holders,
/// funds, commits the pool and settles randomness with `answer`.
fn drawn_setup(env: &mut Env, sold: u16, weights: &[u64], answer: [u8; 64]) -> DrawSetup {
    let leaves = eligible(weights);
    let tree = Tree::build(&leaves).unwrap();
    let id = env.create_break();
    for _ in 0..sold {
        env.sell_one(id);
    }
    env.after_deadline();
    let (anyone, _) = env.user(0);
    env.close(&anyone, id).unwrap();
    env.commit_eligibility_with(id, tree.root().hash, tree.root().sum, leaves.len() as u32)
        .unwrap();
    env.fund(id).unwrap();
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, id, sold + 2.min(leaves.len() as u16))
        .unwrap();
    env.request_randomness(id).unwrap();
    env.mock_fulfill(env.brk(id).randomness_request_id, answer).unwrap();
    env.settle(id).unwrap();
    let seed = env.brk(id).seed;
    DrawSetup { id, leaves, tree, seed }
}

#[test]
fn the_drawn_winners_are_recorded_in_order_and_complete_the_draw() {
    let mut env = Env::ready();
    let d = drawn_setup(&mut env, 3, &[10, 20, 5, 1, 50, 9], [11; 64]);
    assert_eq!(env.brk(d.id).status, BreakStatus::Settled);
    let expected = draw_free_winners(&d.seed, &d.leaves, 2).unwrap();
    assert_eq!(expected.len(), 2);

    // Winner 0.
    let w0 = &expected[0];
    let meta = env
        .claim(d.id, 0, &d.leaves[w0.leaf_index], &d.tree.proof(w0.leaf_index).unwrap())
        .unwrap();
    let b = env.brk(d.id);
    assert_eq!((b.free_winner_count, b.status), (1, BreakStatus::Settled));
    assert_eq!(
        (
            b.free_winners[0].wallet.to_bytes(),
            b.free_winners[0].start,
            b.free_winners[0].weight
        ),
        (d.leaves[w0.leaf_index].wallet, w0.start, w0.weight)
    );
    let event: FreeWinnerClaimed = find_event(&meta.logs).expect("FreeWinnerClaimed event");
    assert_eq!((event.index, event.weight, event.position), (0, w0.weight, w0.position));

    // Winner 1 completes the draw.
    let w1 = &expected[1];
    env.claim(d.id, 1, &d.leaves[w1.leaf_index], &d.tree.proof(w1.leaf_index).unwrap())
        .unwrap();
    let b = env.brk(d.id);
    assert_eq!((b.free_winner_count, b.status), (2, BreakStatus::Drawn));
    assert_ne!(w0.leaf_index, w1.leaf_index, "two different wallets");
    assert_eq!(b.free_winners[1].wallet.to_bytes(), d.leaves[w1.leaf_index].wallet);

    // Nothing more to claim.
    assert_fails_with(
        env.claim(d.id, 2, &d.leaves[0], &d.tree.proof(0).unwrap()),
        code(BreaksError::WrongStatus),
    );
}

#[test]
fn only_the_wallet_the_draw_picked_can_be_claimed() {
    let mut env = Env::ready();
    let d = drawn_setup(&mut env, 3, &[10, 20, 5, 1, 50, 9], [12; 64]);
    let expected = draw_free_winners(&d.seed, &d.leaves, 2).unwrap();
    let picked = expected[0].leaf_index;

    // Every other wallet has a valid proof and a real weight, and is still refused.
    for (i, leaf) in d.leaves.iter().enumerate().filter(|(i, _)| *i != picked) {
        assert_fails_with(
            env.claim(d.id, 0, leaf, &d.tree.proof(i).unwrap()),
            code(BreaksError::NotTheDrawnWinner),
        );
    }
    assert_eq!(env.brk(d.id).free_winner_count, 0);
    // Winner 1's wallet cannot be claimed as winner 0 either.
    assert_fails_with(
        env.claim(
            d.id,
            0,
            &d.leaves[expected[1].leaf_index],
            &d.tree.proof(expected[1].leaf_index).unwrap(),
        ),
        code(BreaksError::NotTheDrawnWinner),
    );
    // The right one works.
    env.claim(d.id, 0, &d.leaves[picked], &d.tree.proof(picked).unwrap())
        .unwrap();
}

#[test]
fn winners_are_claimed_in_order_and_no_more_than_the_draw_produces() {
    let mut env = Env::ready();
    let d = drawn_setup(&mut env, 3, &[10, 20, 5, 1, 50, 9], [13; 64]);
    let expected = draw_free_winners(&d.seed, &d.leaves, 2).unwrap();
    let (w0, w1) = (expected[0].leaf_index, expected[1].leaf_index);

    // Winner 1 first: refused, even though the wallet is the right one for index 1.
    assert_fails_with(
        env.claim(d.id, 1, &d.leaves[w1], &d.tree.proof(w1).unwrap()),
        code(BreaksError::WrongClaimIndex),
    );
    env.claim(d.id, 0, &d.leaves[w0], &d.tree.proof(w0).unwrap()).unwrap();
    // The same index twice.
    assert_fails_with(
        env.claim(d.id, 0, &d.leaves[w0], &d.tree.proof(w0).unwrap()),
        code(BreaksError::WrongClaimIndex),
    );
}

#[test]
fn a_wrong_weight_or_proof_is_rejected() {
    let mut env = Env::ready();
    let d = drawn_setup(&mut env, 3, &[10, 20, 5, 1, 50, 9], [14; 64]);
    let w = draw_free_winners(&d.seed, &d.leaves, 2).unwrap()[0].leaf_index;
    let proof = d.tree.proof(w).unwrap();
    let leaf = d.leaves[w];

    // A heavier weight than the tree has: the proof no longer leads to the root.
    let heavier = Leaf {
        weight: leaf.weight + 1,
        ..leaf
    };
    assert_fails_with(env.claim(d.id, 0, &heavier, &proof), code(BreaksError::InvalidProof));
    // A tampered step.
    let mut tampered = proof.clone();
    tampered[0].sibling.sum += 1;
    assert_fails_with(env.claim(d.id, 0, &leaf, &tampered), code(BreaksError::InvalidProof));
    // A step on the wrong side.
    let mut flipped = proof.clone();
    flipped[0].sibling_is_left = !flipped[0].sibling_is_left;
    assert_fails_with(env.claim(d.id, 0, &leaf, &flipped), code(BreaksError::InvalidProof));
    // A shortened proof.
    assert_fails_with(env.claim(d.id, 0, &leaf, &proof[1..]), code(BreaksError::InvalidProof));
    // A proof from a different tree entirely.
    let other = Tree::build(&eligible(&[1, 2, 3])).unwrap();
    assert_fails_with(
        env.claim(d.id, 0, &leaf, &other.proof(0).unwrap()),
        code(BreaksError::InvalidProof),
    );
    // A zero weight.
    let zero = Leaf { weight: 0, ..leaf };
    assert_fails_with(env.claim(d.id, 0, &zero, &proof), code(BreaksError::InvalidProof));
    assert_eq!(env.brk(d.id).free_winner_count, 0);
}

#[test]
fn claims_wait_for_the_final_seed() {
    let mut env = Env::ready();
    let leaves = eligible(&[10, 20, 5]);
    let tree = Tree::build(&leaves).unwrap();
    let id = env.create_break();
    env.sell_one(id);
    env.after_deadline();
    let (anyone, _) = env.user(0);
    env.close(&anyone, id).unwrap();
    env.commit_eligibility_with(id, tree.root().hash, tree.root().sum, 3)
        .unwrap();
    // No seed yet: the break is merely closed with eligibility committed.
    assert_fails_with(
        env.claim(id, 0, &leaves[0], &tree.proof(0).unwrap()),
        code(BreaksError::WrongStatus),
    );
    env.fund(id).unwrap();
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, id, 3).unwrap();
    assert_fails_with(
        env.claim(id, 0, &leaves[0], &tree.proof(0).unwrap()),
        code(BreaksError::WrongStatus),
    );
    env.request_randomness(id).unwrap();
    assert_fails_with(
        env.claim(id, 0, &leaves[0], &tree.proof(0).unwrap()),
        code(BreaksError::WrongStatus),
    );
}

#[test]
fn a_whale_cannot_be_drawn_twice_and_the_draw_never_runs_out_of_wallets() {
    let mut env = Env::ready();
    // One wallet holds almost all the weight, as in the case a retry rule would fail on.
    let d = drawn_setup(&mut env, 2, &[1, 1, 1, 1_000_000_000_000_000, 1], [15; 64]);
    let expected = draw_free_winners(&d.seed, &d.leaves, 2).unwrap();
    assert_ne!(expected[0].leaf_index, expected[1].leaf_index);
    for (i, w) in expected.iter().enumerate() {
        env.claim(
            d.id,
            i as u8,
            &d.leaves[w.leaf_index],
            &d.tree.proof(w.leaf_index).unwrap(),
        )
        .unwrap();
    }
    assert_eq!(env.brk(d.id).status, BreakStatus::Drawn);
}

#[test]
fn fewer_eligible_holders_than_free_spots_draws_only_those_who_exist() {
    let mut env = Env::ready();
    // 2 free spots but a single eligible holder: the pool has one free pack.
    let d = drawn_setup(&mut env, 3, &[7], [16; 64]);
    assert_eq!(env.brk(d.id).pool_size, 4);
    env.claim(d.id, 0, &d.leaves[0], &d.tree.proof(0).unwrap()).unwrap();
    assert_eq!(env.brk(d.id).status, BreakStatus::Drawn);
    assert_fails_with(
        env.claim(d.id, 1, &d.leaves[0], &d.tree.proof(0).unwrap()),
        code(BreaksError::WrongStatus),
    );
}

#[test]
fn with_nobody_eligible_the_draw_is_complete_as_soon_as_the_seed_is_final() {
    let mut env = Env::ready();
    let id = env.create_break();
    env.sell_one(id);
    env.after_deadline();
    let (anyone, _) = env.user(0);
    env.close(&anyone, id).unwrap();
    env.commit_eligibility_with(id, [0; 32], 0, 0).unwrap();
    env.fund(id).unwrap();
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, id, 1).unwrap();
    env.request_randomness(id).unwrap();
    env.mock_fulfill(env.brk(id).randomness_request_id, [17; 64]).unwrap();
    env.settle(id).unwrap();
    assert_eq!(env.brk(id).status, BreakStatus::Drawn);
    assert_eq!(env.brk(id).free_winner_count, 0);
}

#[test]
fn a_tree_that_lists_one_wallet_twice_cannot_make_it_win_twice() {
    // The keeper's builder never produces this (it rejects duplicates), but the program must not
    // trust that: the same wallet in two leaves would otherwise win two free spots.
    let mut env = Env::ready();
    let wallet = Address::new_unique().to_bytes();
    let (a, b) = (Leaf { wallet, weight: 5 }, Leaf { wallet, weight: 7 });
    let (na, nb) = (leaf_node(&a), leaf_node(&b));
    let root = parent(&na, &nb).unwrap();

    let id = env.create_break();
    env.sell_one(id);
    env.after_deadline();
    let (anyone, _) = env.user(0);
    env.close(&anyone, id).unwrap();
    env.commit_eligibility_with(id, root.hash, root.sum, 2).unwrap();
    env.fund(id).unwrap();
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, id, 3).unwrap();
    env.request_randomness(id).unwrap();
    env.mock_fulfill(env.brk(id).randomness_request_id, [18; 64]).unwrap();
    env.settle(id).unwrap();
    let seed = env.brk(id).seed;

    // Whichever leaf wins first is accepted; the other leaf of the same wallet is then refused.
    let first = draw_free_winners(&seed, &[a, b], 2).unwrap();
    let proofs = [
        vec![draw_core::ProofStep {
            sibling: nb,
            sibling_is_left: false,
        }],
        vec![draw_core::ProofStep {
            sibling: na,
            sibling_is_left: true,
        }],
    ];
    let leaves = [a, b];
    env.claim(id, 0, &leaves[first[0].leaf_index], &proofs[first[0].leaf_index])
        .unwrap();
    assert_fails_with(
        env.claim(id, 1, &leaves[first[1].leaf_index], &proofs[first[1].leaf_index]),
        code(BreaksError::WinnerAlreadyDrawn),
    );
}

#[test]
fn the_config_cannot_allow_more_free_spots_than_the_winner_list_holds() {
    let mut env = Env::base();
    let mut i = env.initialize_ix(&env.authority.pubkey(), env.breaks_programdata);
    i.data = breaks::instruction::Initialize {
        params: breaks::InitializeParams {
            admin: env.admin.pubkey(),
            keeper: env.keeper.pubkey(),
            buyer: env.buyer.pubkey(),
            min_window_secs: 6 * HOUR,
            max_window_secs: 24 * HOUR,
            max_paid_spots: 20,
            max_free_spots: 17,
            randomness_program: mock_orao::ID,
            randomness_timeout_secs: HOUR,
        },
    }
    .data();
    assert_fails_with(env.send_as_authority(&[i]), code(BreaksError::InvalidLimits));
}

#[test]
fn the_config_cannot_allow_more_spots_than_a_break_has_packs() {
    let mut env = Env::base();
    let initialize = |env: &Env, max_paid_spots: u16, max_free_spots: u16| {
        let mut i = env.initialize_ix(&env.authority.pubkey(), env.breaks_programdata);
        i.data = breaks::instruction::Initialize {
            params: breaks::InitializeParams {
                admin: env.admin.pubkey(),
                keeper: env.keeper.pubkey(),
                buyer: env.buyer.pubkey(),
                min_window_secs: 6 * HOUR,
                max_window_secs: 24 * HOUR,
                max_paid_spots,
                max_free_spots,
                randomness_program: mock_orao::ID,
                randomness_timeout_secs: HOUR,
            },
        }
        .data();
        i
    };
    // 65 spots would need 65 packs, and a break lists at most 64.
    let too_many = initialize(&env, 60, 5);
    assert_fails_with(env.send_as_authority(&[too_many]), code(BreaksError::InvalidLimits));
    let exactly = initialize(&env, 48, 16);
    env.send_as_authority(&[exactly]).unwrap();
    let c = env.config();
    assert_eq!((c.max_paid_spots, c.max_free_spots), (48, 16));
}

// ---------------------------------------------------------------- the whole flow

#[test]
fn from_creation_to_committed_pool_no_usdc_is_created_or_destroyed() {
    let mut env = Env::ready();
    let id = env.create_break();
    let buyers: Vec<_> = (0..7).map(|_| env.sell_one(id)).collect();
    let users: Vec<Address> = buyers.iter().map(|(_, a)| *a).collect();
    let (anyone, _) = env.user(0);
    env.after_deadline();
    env.close(&anyone, id).unwrap();
    env.commit_eligibility(id, 5_000, 40).unwrap();
    let total_before_funding = env.total_usdc(&users, &[id]);
    env.fund(id).unwrap();
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, id, 9).unwrap();

    // 7 paid + 2 free = 9 packs of $25 reached the buyer wallet, and not a base unit went missing.
    assert_eq!(env.balance(&env.buyer_usdc), 225 * USDC);
    assert_eq!(env.total_usdc(&users, &[id]), total_before_funding);
    assert_eq!(env.locked(), (0, 0));
    assert_eq!(env.brk(id).status, BreakStatus::PoolCommitted);
}
