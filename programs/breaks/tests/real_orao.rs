//! The breaks program against the REAL ORAO VRF program, inside LiteSVM.
//!
//! `breaks.rs` runs everything against `mock-orao`, a stand-in that copies ORAO's interface. These
//! tests load ORAO's own program and network state, dumped from devnet, so the request the breaks
//! program builds, the fee, the checks ORAO makes and the bytes of the answer are ORAO's. Its
//! oracles are replaced by one test key (the network state is edited), whose real Ed25519
//! signature of the seed is the answer, checked by the Ed25519 precompile like on chain.
//!
//! The tests marked `#[ignore]` need the dump, so a plain `cargo test` skips them. Run them with
//!
//! ```text
//! scripts/dump-orao.sh        # needs the Solana CLI and network access to devnet
//! cargo build-sbf --manifest-path programs/{treasury,breaks}/Cargo.toml
//! cargo test -p breaks --test real_orao -- --ignored
//! ```
//!
//! CI does exactly this (job `programs`) and fails when the dump is missing. The tests without
//! `#[ignore]` check the helpers against bytes the real `orao-solana-vrf` crate produced
//! (`tools/orao-fixtures`) and need nothing.

use breaks::{
    errors::BreaksError,
    randomness::{draw_seed, parse_request, request_address, RequestState},
    state::BreakStatus,
};
use draw_core::{draw_free_winners, Tree};
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;
use testkit::*;

mod common;
use common::{
    code, eligible, orao,
    orao::{NetworkState, RealOrao},
    Env, HOUR, T0,
};

// ---------------------------------------------------------------- bytes of the real crate

// From `tools/orao-fixtures` (the real `orao-solana-vrf` 0.7.0 crate): an oracle whose secret is
// 32 copies of 5 answering the request for seed [9; 32] made by client [0x66; 32], paid by [0x77; 32].
const REAL_ED25519_DATA: &str = "01003000ffff1000ffff70002000ffff6e7a1cdd29b0b78fd13af4c5598feff4ef2a97166e3ca6f2e4fbfccd80505bf186c3e25328bf37db8d0ece606027988bdf27dc95e12b1e5c48094c769377a5f8d4b759d0fc6e0563d414389728c23e39ad84de8db6b77a753db271ec335588020909090909090909090909090909090909090909090909090909090909090909";
const REAL_FULFIL_DATA: &str = "a4e3ed54706f93c4";
const REAL_ORACLE: &str = "8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe";
// The same crate's network state without oracles or token fee, and with both.
const REAL_STATE_PLAIN: &str = "d4ed943861f533a911111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222c0e1e400000000000000000000141a99be1c000000";
const REAL_STATE_FULL: &str = "d4ed943861f533a911111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222c0e1e4000000000003000000303030303030303030303030303030303030303030303030303030303030303031313131313131313131313131313131313131313131313131313131313131313232323232323232323232323232323232323232323232323232323232323232014141414141414141414141414141414141414141414141414141414141414141424242424242424242424242424242424242424242424242424242424242424200863ba101000000141a99be1c000000";

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn the_answer_instructions_are_what_the_real_crate_builds() {
    let oracle = Keypair::new_from_array([5; 32]);
    assert_eq!(oracle.pubkey().to_string(), REAL_ORACLE);
    let seed = [9u8; 32];

    let signature = orao::sign(&oracle, &seed);
    let ed25519 = orao::ed25519_instruction_with(&oracle.pubkey().to_bytes(), &signature, &seed);
    assert_eq!(ed25519.program_id, orao::ed25519_program());
    assert!(ed25519.accounts.is_empty());
    assert_eq!(hex(&ed25519.data), REAL_ED25519_DATA);

    let payer = Address::new_from_array([0x77; 32]);
    let client = Address::new_from_array([0x66; 32]);
    let request = request_address(&orao::id(), &seed);
    let fulfil = orao::fulfill_v2_instruction(&payer, &request, &client);
    assert_eq!(fulfil.program_id, orao::id());
    assert_eq!(hex(&fulfil.data), REAL_FULFIL_DATA);
    let accounts: Vec<(Address, bool, bool)> = fulfil
        .accounts
        .iter()
        .map(|m| (m.pubkey, m.is_signer, m.is_writable))
        .collect();
    assert_eq!(
        accounts,
        vec![
            (payer, true, true),
            (orao::instructions_sysvar(), false, false),
            (orao::network_state_address(), false, true),
            (request, false, true),
            (client, false, true),
            (anchor_lang::system_program::ID, false, false),
        ]
    );
}

#[test]
fn the_ed25519_precompile_in_litesvm_checks_the_signature_in_that_instruction() {
    // ORAO does not verify the signature itself; it relies on this precompile having done so.
    let mut svm = litesvm::LiteSVM::new();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let oracle = Keypair::new();
    let seed = [4u8; 32];
    let signature = orao::sign(&oracle, &seed);

    let good = orao::ed25519_instruction_with(&oracle.pubkey().to_bytes(), &signature, &seed);
    send(&mut svm, &payer, &[], &[good]).expect("a good signature passes");

    let mut forged = signature;
    forged[3] ^= 1;
    let bad = orao::ed25519_instruction_with(&oracle.pubkey().to_bytes(), &forged, &seed);
    assert!(send(&mut svm, &payer, &[], &[bad]).is_err(), "a forged signature fails");

    let other_message = orao::ed25519_instruction_with(&oracle.pubkey().to_bytes(), &signature, &[5u8; 32]);
    assert!(
        send(&mut svm, &payer, &[], &[other_message]).is_err(),
        "a signature of another message fails"
    );

    let other_key = orao::ed25519_instruction_with(&Keypair::new().pubkey().to_bytes(), &signature, &seed);
    assert!(
        send(&mut svm, &payer, &[], &[other_key]).is_err(),
        "a signature under another key fails"
    );
}

#[test]
fn the_discriminators_are_anchors() {
    assert_eq!(
        orao::FULFILL_V2_DISCRIMINATOR,
        solana_sha256_hasher::hashv(&[b"global:fulfill_v2"]).to_bytes()[..8]
    );
    let state = NetworkState::parse(&unhex(REAL_STATE_PLAIN)).unwrap();
    assert_eq!(
        state.discriminator,
        solana_sha256_hasher::hashv(&[b"account:NetworkState"]).to_bytes()[..8]
    );
}

#[test]
fn the_network_state_is_read_and_written_like_the_real_crate_does() {
    let plain = unhex(REAL_STATE_PLAIN);
    let s = NetworkState::parse(&plain).unwrap();
    assert_eq!(
        (s.request_fee, s.oracles.len(), s.token_fee.is_none(), s.num_received),
        (15_000_000, 0, true, 123_456_789_012)
    );
    assert_eq!(s.authority, [0x11; 32]);
    assert_eq!(s.treasury, [0x22; 32]);
    assert_eq!(s.to_bytes(plain.len()), plain);

    let full = unhex(REAL_STATE_FULL);
    let s = NetworkState::parse(&full).unwrap();
    assert_eq!(s.oracles, vec![[0x30; 32], [0x31; 32], [0x32; 32]]);
    let fee = s.token_fee.expect("token fee");
    assert_eq!((&fee[..32], &fee[32..64]), (&[0x41; 32][..], &[0x42; 32][..]));
    assert_eq!(u64::from_le_bytes(fee[64..].try_into().unwrap()), 7_000_000_000);
    assert_eq!(s.to_bytes(full.len()), full);
}

#[test]
fn replacing_the_oracles_changes_nothing_else_and_keeps_the_account_size() {
    // ORAO allocates 8 + 464 bytes; the struct is shorter and the rest is zeros.
    let mut account = unhex(REAL_STATE_FULL);
    account.resize(8 + 464, 0);
    let original = NetworkState::parse(&account).unwrap();

    let mut edited = original.clone();
    edited.oracles = vec![[7; 32]];
    let bytes = edited.to_bytes(account.len());
    assert_eq!(bytes.len(), account.len());

    let back = NetworkState::parse(&bytes).unwrap();
    assert_eq!(back.oracles, vec![[7; 32]]);
    assert_eq!(
        (
            back.authority,
            back.treasury,
            back.request_fee,
            back.token_fee,
            back.num_received
        ),
        (
            original.authority,
            original.treasury,
            original.request_fee,
            original.token_fee,
            original.num_received
        )
    );
    // Nothing but zeros after the struct.
    let used = 8 + 32 + 32 + 8 + 4 + 32 + 1 + 72 + 8;
    assert!(bytes[used..].iter().all(|b| *b == 0));
}

#[test]
fn a_network_state_that_does_not_parse_is_refused() {
    let full = unhex(REAL_STATE_FULL);
    assert!(NetworkState::parse(&full[..40]).is_err());
    let mut bad_tag = full.clone();
    bad_tag[8 + 32 + 32 + 8 + 4 + 96] = 2;
    assert!(NetworkState::parse(&bad_tag).is_err());
    let mut too_many = full;
    too_many[8 + 32 + 32 + 8] = 11;
    assert!(NetworkState::parse(&too_many).is_err());
}

// ---------------------------------------------------------------- against the real program

/// ORAO's oracle answers the request for `seed` that `client` made: signs `message` with `signer`
/// and sends the Ed25519 instruction and `fulfill_v2` like ORAO's oracles do.
fn answer_with(env: &mut Env, signer: &Keypair, message: &[u8], seed: &[u8; 32], client: &Address) -> Sent {
    let payer = Keypair::new();
    env.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let signature = orao::sign(signer, message);
    let ed25519 = orao::ed25519_instruction_with(&signer.pubkey().to_bytes(), &signature, message);
    let fulfil = orao::fulfill_v2_instruction(&payer.pubkey(), &env.request_for(seed), client);
    send(&mut env.svm, &payer, &[], &[ed25519, fulfil])
}

/// The proper answer: the test oracle signs the seed of the request.
fn answer(env: &mut Env, orao: &RealOrao, seed: &[u8; 32], client: &Address) -> Sent {
    answer_with(env, &orao.oracle, seed, seed, client)
}

fn request_state(env: &Env, seed: &[u8; 32]) -> RequestState {
    let account = env.svm.get_account(&env.request_for(seed)).expect("request account");
    parse_request(&account.data, seed).unwrap()
}

/// The transaction must have failed. The error and the program logs go to the test output
/// (`--nocapture`), so a refusal can be checked for being the right one.
fn refused(result: Sent, what: &str) -> litesvm::types::FailedTransactionMetadata {
    match result {
        Ok(_) => panic!("{what}: expected a refusal, but the transaction succeeded"),
        Err(failed) => {
            println!("--- {what}: {:?}\n{}", failed.err, failed.meta.logs.join("\n"));
            failed
        }
    }
}

fn network_state(env: &Env) -> NetworkState {
    NetworkState::parse(&env.svm.get_account(&orao::network_state_address()).unwrap().data).unwrap()
}

/// A break with its pool committed and randomness requested through the breaks program.
fn requested(env: &mut Env) -> (u64, [u8; 32]) {
    let id = common::committed(env);
    env.request_randomness(id).unwrap();
    let request_id = env.brk(id).randomness_request_id;
    (id, request_id)
}

#[test]
#[ignore = "needs ORAO's dump: scripts/dump-orao.sh, then cargo test -p breaks --test real_orao -- --ignored"]
fn the_real_program_takes_the_request_the_breaks_program_sends_and_charges_its_fee() {
    let orao = RealOrao::load();
    let mut env = Env::ready_with(Some(&orao));
    let id = common::committed(&mut env);
    let keeper = env.keeper.pubkey();
    let (keeper_before, treasury_before) = (
        env.svm.get_balance(&keeper).unwrap(),
        env.svm.get_balance(&orao.treasury).unwrap(),
    );
    let received_before = network_state(&env).num_received;

    env.request_randomness(id).unwrap();

    let b = env.brk(id);
    assert_eq!(b.status, BreakStatus::RandomnessRequested);
    // ORAO made the request account for exactly the seed the breaks program asked for.
    let request = env.request_for(&b.randomness_request_id);
    let account = env.svm.get_account(&request).expect("ORAO created the request");
    assert_eq!(account.owner, orao::id());
    assert_eq!(account.data.len(), orao::REQUEST_ACCOUNT_SIZE);
    assert_eq!(request_state(&env, &b.randomness_request_id), RequestState::Pending);

    // The fee went to the treasury ORAO names, the keeper paid it and the account's rent, and
    // ORAO counted the request.
    let fee = orao.request_fee;
    println!(
        "devnet network state: fee {fee} lamports, treasury {}, {} oracles replaced by 1, token fee {}",
        orao.treasury,
        orao.devnet_oracles,
        if orao.devnet_token_fee { "configured" } else { "none" }
    );
    assert_eq!(env.svm.get_balance(&orao.treasury).unwrap() - treasury_before, fee);
    let rent = env.svm.minimum_balance_for_rent_exemption(orao::REQUEST_ACCOUNT_SIZE);
    let paid = keeper_before - env.svm.get_balance(&keeper).unwrap();
    assert!(paid >= fee + rent, "keeper paid {paid}, fee {fee}, rent {rent}");
    assert!(
        paid - (fee + rent) < 100_000,
        "only the transaction fee is left: {paid}"
    );
    assert_eq!(network_state(&env).num_received, received_before + 1);
}

#[test]
#[ignore = "needs ORAO's dump: scripts/dump-orao.sh, then cargo test -p breaks --test real_orao -- --ignored"]
fn the_oracles_signature_becomes_the_seed_and_the_free_spots_are_drawn_from_it() {
    let orao = RealOrao::load();
    let mut env = Env::ready_with(Some(&orao));
    let leaves = eligible(&[10, 20, 5, 1, 50, 9]);
    let tree = Tree::build(&leaves).unwrap();
    let id = env.create_break();
    for _ in 0..3 {
        env.sell_one(id);
    }
    env.after_deadline();
    let (anyone, _) = env.user(0);
    env.close(&anyone, id).unwrap();
    env.commit_eligibility_with(id, tree.root().hash, tree.root().sum, leaves.len() as u32)
        .unwrap();
    env.fund(id).unwrap();
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, id, 3 + 2).unwrap();
    env.request_randomness(id).unwrap();
    let request_id = env.brk(id).randomness_request_id;

    // Nothing to settle before the oracle has answered.
    assert_fails_with(env.settle(id), code(BreaksError::RandomnessNotFulfilled));
    answer(&mut env, &orao, &request_id, &keeper.pubkey()).unwrap();

    // With one oracle the combined randomness is its signature of the seed.
    let signature = orao::sign(&orao.oracle, &request_id);
    assert_eq!(request_state(&env, &request_id), RequestState::Fulfilled(signature));

    env.settle(id).unwrap();
    let b = env.brk(id);
    assert_eq!((b.status, b.seed), (BreakStatus::Settled, draw_seed(&signature)));

    // The draw runs from that seed, as it does with the mock.
    let winners = draw_free_winners(&b.seed, &leaves, 2).unwrap();
    for (index, w) in winners.iter().enumerate() {
        env.claim(
            id,
            index as u8,
            &leaves[w.leaf_index],
            &tree.proof(w.leaf_index).unwrap(),
        )
        .unwrap();
    }
    let b = env.brk(id);
    assert_eq!((b.status, b.free_winner_count), (BreakStatus::Drawn, 2));
    for (index, w) in winners.iter().enumerate() {
        assert_eq!(b.free_winners[index].wallet.to_bytes(), leaves[w.leaf_index].wallet);
    }
}

#[test]
#[ignore = "needs ORAO's dump: scripts/dump-orao.sh, then cargo test -p breaks --test real_orao -- --ignored"]
fn an_answer_that_is_not_the_oracles_signature_of_the_seed_is_refused() {
    let orao = RealOrao::load();
    let mut env = Env::ready_with(Some(&orao));
    let (id, request_id) = requested(&mut env);
    let keeper = env.keeper.pubkey();

    // A key that is not one of the oracles.
    let impostor = Keypair::new();
    refused(
        answer_with(&mut env, &impostor, &request_id, &request_id, &keeper),
        "a key that is not an oracle",
    );
    // The oracle signing something else than the seed.
    refused(
        answer_with(&mut env, &orao.oracle, &[1u8; 32], &request_id, &keeper),
        "the oracle signs another message",
    );
    // The right instruction for another client.
    let stranger = Address::new_unique();
    refused(
        answer_with(&mut env, &orao.oracle, &request_id, &request_id, &stranger),
        "another client",
    );
    // `fulfill_v2` on its own, with no signature in front of it.
    let payer = Keypair::new();
    env.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let alone = orao::fulfill_v2_instruction(&payer.pubkey(), &env.request_for(&request_id), &keeper);
    refused(
        send(&mut env.svm, &payer, &[], &[alone]),
        "fulfill_v2 without a signature",
    );
    // A forged signature: the precompile rejects it.
    let mut signature = orao::sign(&orao.oracle, &request_id);
    signature[10] ^= 1;
    let forged = orao::ed25519_instruction_with(&orao.oracle.pubkey().to_bytes(), &signature, &request_id);
    let fulfil = orao::fulfill_v2_instruction(&payer.pubkey(), &env.request_for(&request_id), &keeper);
    refused(send(&mut env.svm, &payer, &[], &[forged, fulfil]), "a forged signature");

    // None of it answered the request.
    assert_eq!(request_state(&env, &request_id), RequestState::Pending);
    assert_fails_with(env.settle(id), code(BreaksError::RandomnessNotFulfilled));

    // And the proper answer still works afterwards.
    answer(&mut env, &orao, &request_id, &keeper).unwrap();
    env.settle(id).unwrap();
}

#[test]
#[ignore = "needs ORAO's dump: scripts/dump-orao.sh, then cargo test -p breaks --test real_orao -- --ignored"]
fn a_request_a_stranger_made_first_with_the_real_program_is_adopted() {
    let orao = RealOrao::load();
    let mut env = Env::ready_with(Some(&orao));
    let id = common::committed(&mut env);
    let seed = env.request_id_for(id, 0);

    // The seed is computable once the commitments are on chain, so anyone can ask ORAO for it.
    let (stranger, _) = env.user(0);
    let squat = orao::request_v2_instruction(&stranger.pubkey(), &orao.treasury, seed);
    send(&mut env.svm, &stranger, &[], &[squat]).unwrap();
    assert_eq!(request_state(&env, &seed), RequestState::Pending);
    let treasury_after_squat = env.svm.get_balance(&orao.treasury).unwrap();

    // The keeper's request does not fail and does not ask (or pay) again.
    env.request_randomness(id).unwrap();
    let b = env.brk(id);
    assert_eq!(
        (b.status, b.randomness_request_id),
        (BreakStatus::RandomnessRequested, seed)
    );
    assert_eq!(env.svm.get_balance(&orao.treasury).unwrap(), treasury_after_squat);

    // ORAO's answer goes to the stranger's request, which the break now uses.
    answer(&mut env, &orao, &seed, &stranger.pubkey()).unwrap();
    env.settle(id).unwrap();
    assert_eq!(env.brk(id).seed, draw_seed(&orao::sign(&orao.oracle, &seed)));
}

#[test]
#[ignore = "needs ORAO's dump: scripts/dump-orao.sh, then cargo test -p breaks --test real_orao -- --ignored"]
fn a_repeated_request_is_a_new_request_and_the_old_answer_is_ignored() {
    let orao = RealOrao::load();
    let mut env = Env::ready_with(Some(&orao));
    let (id, first) = requested(&mut env);
    let keeper = env.keeper.pubkey();

    set_unix_time(&mut env.svm, T0 + 6 * HOUR + HOUR);
    env.repeat_randomness(id).unwrap();
    let b = env.brk(id);
    let second = b.randomness_request_id;
    assert_eq!((b.status, b.randomness_attempt), (BreakStatus::RandomnessRequested, 1));
    assert_ne!(first, second);
    assert_eq!(request_state(&env, &second), RequestState::Pending);

    // ORAO finally answers the OLD request: the break ignores it.
    answer(&mut env, &orao, &first, &keeper).unwrap();
    let (stranger, _) = env.user(0);
    let old_record = env.request_for(&first);
    assert_fails_with(
        env.settle_with(&stranger, id, old_record),
        code(BreaksError::InvalidRandomnessRecord),
    );
    assert_fails_with(env.settle(id), code(BreaksError::RandomnessNotFulfilled));

    answer(&mut env, &orao, &second, &keeper).unwrap();
    env.settle(id).unwrap();
    assert_eq!(env.brk(id).seed, draw_seed(&orao::sign(&orao.oracle, &second)));
}

#[test]
#[ignore = "needs ORAO's dump: scripts/dump-orao.sh, then cargo test -p breaks --test real_orao -- --ignored"]
fn an_answered_request_cannot_be_replaced_by_asking_again() {
    let orao = RealOrao::load();
    let mut env = Env::ready_with(Some(&orao));
    let (id, request_id) = requested(&mut env);
    let keeper = env.keeper.pubkey();
    answer(&mut env, &orao, &request_id, &keeper).unwrap();

    // Long after the timeout a keeper still cannot re-roll an answer it does not like.
    set_unix_time(&mut env.svm, T0 + 6 * HOUR + 10 * HOUR);
    assert_fails_with(env.repeat_randomness(id), code(BreaksError::AlreadyFulfilled));
    env.settle(id).unwrap();
    assert_eq!(env.brk(id).seed, draw_seed(&orao::sign(&orao.oracle, &request_id)));

    // ORAO does not take a second answer either.
    refused(
        answer(&mut env, &orao, &request_id, &keeper),
        "a second answer to an answered request",
    );
}
