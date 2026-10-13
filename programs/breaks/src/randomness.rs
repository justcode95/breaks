//! Randomness comes from the ORAO VRF program (`VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y`, the
//! same address on mainnet and devnet). We do not use ORAO's Rust crate (it targets an older
//! Anchor); we call `request_v2` with a hand-built instruction and read the request account's
//! bytes. Both layouts are pinned by tests against fixtures produced by the real crate.
//!
//! How it works:
//! - `request_randomness` asks ORAO for a random value with `seed = request_id`, which commits to
//!   the break, the attempt, the eligibility root and the pool hash. Nobody can know the seed (so
//!   nobody can prepare a request for it) before those two are committed.
//! - ORAO's oracles answer by writing 64 bytes (an Ed25519 signature of the seed) into the request
//!   account. Anyone can verify it against ORAO's public key.
//! - `settle_randomness` reads that answer and stores `sha256("breaks:seed:v1" || answer)` as the
//!   seed of the draw.
//!
//! The program id is part of the config, so the admin (multisig) can point `breaks` at another
//! program with the same interface; tests use `programs/mock-orao`.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke,
    },
};
use solana_sha256_hasher::hashv;

use crate::errors::BreaksError;

/// Seed ORAO uses for request accounts.
pub const REQUEST_ACCOUNT_SEED: &[u8] = b"orao-vrf-randomness-request";
/// `sha256("global:request_v2")[..8]`
pub const REQUEST_V2_DISCRIMINATOR: [u8; 8] = [38, 151, 209, 6, 195, 102, 28, 217];
/// `sha256("account:RandomnessV2")[..8]`
const REQUEST_ACCOUNT_DISCRIMINATOR: [u8; 8] = [139, 239, 184, 215, 227, 86, 191, 226];
/// How many times a request can be repeated when ORAO never answers.
pub const MAX_ATTEMPTS: u8 = 5;

// Layout of ORAO's `RandomnessV2` account: discriminator (8), enum tag (1), then client (32) and
// seed (32); a pending request continues with a response list, a fulfilled one with the 64 bytes.
const TAG_OFFSET: usize = 8;
const SEED_OFFSET: usize = 41;
const PENDING_MIN_LEN: usize = SEED_OFFSET + 32 + 4;
const RANDOMNESS_OFFSET: usize = SEED_OFFSET + 32;
const FULFILLED_MIN_LEN: usize = RANDOMNESS_OFFSET + 64;

/// The seed we give ORAO. It commits to the break, the attempt and the two commitments that must
/// exist before the draw.
pub fn request_id(break_key: &Pubkey, attempt: u8, eligibility_root: &[u8; 32], pool_hash: &[u8; 32]) -> [u8; 32] {
    hashv(&[
        b"breaks:randomness:v1",
        break_key.as_ref(),
        &[attempt],
        eligibility_root,
        pool_hash,
    ])
    .to_bytes()
}

/// Where the VRF program keeps the request for `seed`.
pub fn request_address(vrf: &Pubkey, seed: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[REQUEST_ACCOUNT_SEED, seed], vrf).0
}

/// The draw's seed: ORAO's 64 bytes reduced to 32 and tagged.
pub fn draw_seed(randomness: &[u8; 64]) -> [u8; 32] {
    hashv(&[b"breaks:seed:v1", randomness]).to_bytes()
}

#[derive(Debug, PartialEq, Eq)]
pub enum RequestState {
    Pending,
    Fulfilled([u8; 64]),
}

/// Reads the bytes of an ORAO request account. Fails unless it is for `expected_seed`.
pub fn parse_request(data: &[u8], expected_seed: &[u8; 32]) -> Result<RequestState> {
    require!(
        data.len() >= PENDING_MIN_LEN && data[..8] == REQUEST_ACCOUNT_DISCRIMINATOR,
        BreaksError::InvalidRandomnessRecord
    );
    require!(
        &data[SEED_OFFSET..SEED_OFFSET + 32] == expected_seed,
        BreaksError::InvalidRandomnessRecord
    );
    match data[TAG_OFFSET] {
        0 => Ok(RequestState::Pending),
        1 => {
            require!(data.len() >= FULFILLED_MIN_LEN, BreaksError::InvalidRandomnessRecord);
            let mut randomness = [0u8; 64];
            randomness.copy_from_slice(&data[RANDOMNESS_OFFSET..FULFILLED_MIN_LEN]);
            // A signature is never all zeros; refuse a blank "answer".
            require!(randomness != [0u8; 64], BreaksError::InvalidRandomnessRecord);
            Ok(RequestState::Fulfilled(randomness))
        }
        _ => err!(BreaksError::InvalidRandomnessRecord),
    }
}

/// Reads a request account: it must be owned by the VRF program, sit at the address derived from
/// `expected_seed`, and be for that seed.
pub fn read_request(request: &AccountInfo, vrf: &Pubkey, expected_seed: &[u8; 32]) -> Result<RequestState> {
    require_keys_eq!(*request.owner, *vrf, BreaksError::InvalidRandomnessRecord);
    require_keys_eq!(
        request.key(),
        request_address(vrf, expected_seed),
        BreaksError::InvalidRandomnessRecord
    );
    parse_request(&request.try_borrow_data()?, expected_seed)
}

/// Accounts ORAO's `request_v2` needs besides the program itself.
pub struct RequestV2Accounts<'a, 'info> {
    pub vrf_program: &'a AccountInfo<'info>,
    /// Pays the request fee and the rent of the request account.
    pub payer: &'a AccountInfo<'info>,
    pub network_state: &'a AccountInfo<'info>,
    pub treasury: &'a AccountInfo<'info>,
    pub request: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    /// ORAO's token-fee accounts, only needed when it charges its fee in ORAO tokens.
    pub extra: &'a [AccountInfo<'info>],
}

/// Calls `request_v2(seed)`. The payer signs the outer transaction.
pub fn request_v2(a: &RequestV2Accounts, seed: [u8; 32]) -> Result<()> {
    let mut metas = vec![
        AccountMeta::new(a.payer.key(), true),
        AccountMeta::new(a.network_state.key(), false),
        AccountMeta::new(a.treasury.key(), false),
        AccountMeta::new(a.request.key(), false),
        AccountMeta::new_readonly(a.system_program.key(), false),
    ];
    let mut infos = vec![
        a.payer.clone(),
        a.network_state.clone(),
        a.treasury.clone(),
        a.request.clone(),
        a.system_program.clone(),
        a.vrf_program.clone(),
    ];
    for extra in a.extra {
        metas.push(if extra.is_writable {
            AccountMeta::new(extra.key(), extra.is_signer)
        } else {
            AccountMeta::new_readonly(extra.key(), extra.is_signer)
        });
        infos.push(extra.clone());
    }
    let mut data = REQUEST_V2_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&seed);
    invoke(
        &Instruction {
            program_id: a.vrf_program.key(),
            accounts: metas,
            data,
        },
        &infos,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bytes produced by the real `orao-solana-vrf` 0.7.0 crate for client = [7; 32],
    // seed = [9; 32], randomness = 0..64.
    const REAL_FULFILLED: &str = "8befb8d7e356bfe20107070707070707070707070707070707070707070707070707070707070707070909090909090909090909090909090909090909090909090909090909090909000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
    const REAL_PENDING: &str = "8befb8d7e356bfe2000707070707070707070707070707070707070707070707070707070707070707090909090909090909090909090909090909090909090909090909090909090900000000";
    const SEED: [u8; 32] = [9; 32];

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn the_constants_are_the_anchor_discriminators() {
        assert_eq!(REQUEST_V2_DISCRIMINATOR, hashv(&[b"global:request_v2"]).to_bytes()[..8]);
        assert_eq!(
            REQUEST_ACCOUNT_DISCRIMINATOR,
            hashv(&[b"account:RandomnessV2"]).to_bytes()[..8]
        );
    }

    #[test]
    fn reads_the_bytes_the_real_program_writes() {
        assert_eq!(
            parse_request(&unhex(REAL_PENDING), &SEED).unwrap(),
            RequestState::Pending
        );
        let mut expected = [0u8; 64];
        for (i, b) in expected.iter_mut().enumerate() {
            *b = i as u8;
        }
        // The first byte is 0, but the rest is not blank, so it is a real answer.
        assert_eq!(
            parse_request(&unhex(REAL_FULFILLED), &SEED).unwrap(),
            RequestState::Fulfilled(expected)
        );
    }

    #[test]
    fn a_pending_account_keeps_its_size_after_the_real_program_fulfils_it() {
        // ORAO allocates 749 bytes up front; a fulfilled answer is shorter and the rest stays zero.
        let mut data = unhex(REAL_FULFILLED);
        data.resize(749, 0);
        assert!(matches!(
            parse_request(&data, &SEED).unwrap(),
            RequestState::Fulfilled(_)
        ));
        let mut pending = unhex(REAL_PENDING);
        pending.resize(749, 0);
        assert_eq!(parse_request(&pending, &SEED).unwrap(), RequestState::Pending);
    }

    #[test]
    fn refuses_accounts_that_are_not_requests_for_this_seed() {
        assert!(parse_request(&unhex(REAL_FULFILLED), &[1u8; 32]).is_err()); // another seed
        assert!(parse_request(&[], &SEED).is_err());
        assert!(parse_request(&unhex(REAL_FULFILLED)[..100], &SEED).is_err()); // cut short
        let mut wrong_type = unhex(REAL_FULFILLED);
        wrong_type[0] ^= 1;
        assert!(parse_request(&wrong_type, &SEED).is_err());
        let mut bad_tag = unhex(REAL_FULFILLED);
        bad_tag[8] = 2;
        assert!(parse_request(&bad_tag, &SEED).is_err());
        let mut blank = unhex(REAL_FULFILLED);
        blank[RANDOMNESS_OFFSET..FULFILLED_MIN_LEN].fill(0);
        assert!(parse_request(&blank, &SEED).is_err());
    }

    #[test]
    fn request_ids_depend_on_everything_they_commit_to() {
        let (k, root, pool) = (Pubkey::new_unique(), [1u8; 32], [2u8; 32]);
        let base = request_id(&k, 0, &root, &pool);
        assert_eq!(base, request_id(&k, 0, &root, &pool));
        assert_ne!(base, request_id(&Pubkey::new_unique(), 0, &root, &pool));
        assert_ne!(base, request_id(&k, 1, &root, &pool));
        assert_ne!(base, request_id(&k, 0, &[3u8; 32], &pool));
        assert_ne!(base, request_id(&k, 0, &root, &[3u8; 32]));
    }

    #[test]
    fn the_draw_seed_depends_on_the_whole_answer() {
        let a = [5u8; 64];
        let mut b = a;
        b[63] ^= 1;
        assert_eq!(draw_seed(&a), draw_seed(&a));
        assert_ne!(draw_seed(&a), draw_seed(&b));
    }
}
