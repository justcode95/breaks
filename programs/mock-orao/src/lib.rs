//! TEST-ONLY stand-in for the ORAO VRF program (`VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y`).
//!
//! It has the same `request_v2` instruction (discriminator, arguments, account order) and writes
//! request accounts with the same bytes as ORAO, so the `breaks` program runs exactly the code it
//! runs against the real thing. The difference: here anyone can fulfil a request with any value
//! (`fulfill_for_test`), so there is no randomness at all. It lets the whole break pipeline be
//! tested without ORAO's oracles. Never point a real deployment at it.
//!
//! The byte layout is checked against the real `orao-solana-vrf` 0.7.0 crate by the fixtures in
//! the tests below.

use anchor_lang::prelude::*;

// Placeholder ID of the MOCK (not ORAO's). Replace with `anchor keys sync` for a devnet deployment.
declare_id!("8RM7tyH43idAciXbkKPpN2xVUMhkUkeVACSp87WXhT3i");

/// Same seed ORAO uses for request accounts.
pub const RANDOMNESS_ACCOUNT_SEED: &[u8] = b"orao-vrf-randomness-request";

#[program]
pub mod mock_orao {
    use super::*;

    /// Same signature as ORAO's `request_v2`. The real one also charges the request fee and checks
    /// the treasury against its network state; this one only creates the pending request.
    pub fn request_v2(ctx: Context<RequestV2>, seed: [u8; 32]) -> Result<()> {
        require!(seed != [0u8; 32], MockOraoError::ZeroSeed);
        ctx.accounts.request.request = RequestAccount::Pending(PendingRequest {
            client: ctx.accounts.payer.key(),
            seed,
            responses: vec![],
        });
        Ok(())
    }

    /// Test helper standing in for ORAO's oracles: completes a request with a chosen value.
    pub fn fulfill_for_test(ctx: Context<FulfillForTest>, seed: [u8; 32], randomness: [u8; 64]) -> Result<()> {
        let request = &mut ctx.accounts.request;
        require!(
            matches!(request.request, RequestAccount::Pending(_)),
            MockOraoError::AlreadyFulfilled
        );
        require!(*request.request.seed() == seed, MockOraoError::WrongRequest);
        let client = *request.request.client();
        request.request = RequestAccount::Fulfilled(FulfilledRequest {
            client,
            seed,
            randomness,
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub struct RandomnessResponse {
    pub pubkey: Pubkey,
    pub randomness: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub struct PendingRequest {
    pub client: Pubkey,
    pub seed: [u8; 32],
    pub responses: Vec<RandomnessResponse>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub struct FulfilledRequest {
    pub client: Pubkey,
    pub seed: [u8; 32],
    pub randomness: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum RequestAccount {
    Pending(PendingRequest),
    Fulfilled(FulfilledRequest),
}

impl RequestAccount {
    pub fn seed(&self) -> &[u8; 32] {
        match self {
            RequestAccount::Pending(x) => &x.seed,
            RequestAccount::Fulfilled(x) => &x.seed,
        }
    }

    pub fn client(&self) -> &Pubkey {
        match self {
            RequestAccount::Pending(x) => &x.client,
            RequestAccount::Fulfilled(x) => &x.client,
        }
    }
}

/// The name matters: it gives the account the same 8-byte discriminator as ORAO's.
#[account]
pub struct RandomnessV2 {
    pub request: RequestAccount,
}

impl RandomnessV2 {
    /// ORAO allocates room for 7 responses (a Byzantine quorum of 10 authorities).
    pub const PENDING_SIZE: usize = 1 + 32 + 32 + 4 + (32 + 64) * 7;
}

#[derive(Accounts)]
#[instruction(seed: [u8; 32])]
pub struct RequestV2<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: ORAO's network state; the mock does not read it.
    #[account(mut)]
    pub network_state: UncheckedAccount<'info>,
    /// CHECK: ORAO's fee treasury; the mock does not read it.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + RandomnessV2::PENDING_SIZE, seeds = [RANDOMNESS_ACCOUNT_SEED, &seed], bump)]
    pub request: Account<'info, RandomnessV2>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed: [u8; 32])]
pub struct FulfillForTest<'info> {
    #[account(mut, seeds = [RANDOMNESS_ACCOUNT_SEED, &seed], bump)]
    pub request: Account<'info, RandomnessV2>,
}

#[error_code]
pub enum MockOraoError {
    #[msg("Randomness seed cannot be zero")]
    ZeroSeed,
    #[msg("Already fulfilled")]
    AlreadyFulfilled,
    #[msg("The request belongs to another seed")]
    WrongRequest,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{AccountSerialize, InstructionData};

    // Bytes produced by the real `orao-solana-vrf` 0.7.0 crate for client = [7; 32],
    // seed = [9; 32], randomness = 0..64 (see CLAUDE.md, "Randomness").
    const REAL_FULFILLED: &str = "8befb8d7e356bfe20107070707070707070707070707070707070707070707070707070707070707070909090909090909090909090909090909090909090909090909090909090909000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
    const REAL_PENDING: &str = "8befb8d7e356bfe2000707070707070707070707070707070707070707070707070707070707070707090909090909090909090909090909090909090909090909090909090909090900000000";
    const REAL_REQUEST_V2: &str = "2697d106c3661cd90909090909090909090909090909090909090909090909090909090909090909";

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn bytes_of(request: RequestAccount) -> Vec<u8> {
        let mut data = Vec::new();
        RandomnessV2 { request }.try_serialize(&mut data).unwrap();
        data
    }

    #[test]
    fn request_accounts_have_exactly_the_bytes_the_real_program_writes() {
        let client = Pubkey::new_from_array([7; 32]);
        let mut randomness = [0u8; 64];
        for (i, b) in randomness.iter_mut().enumerate() {
            *b = i as u8;
        }
        let fulfilled = RequestAccount::Fulfilled(FulfilledRequest {
            client,
            seed: [9; 32],
            randomness,
        });
        let pending = RequestAccount::Pending(PendingRequest {
            client,
            seed: [9; 32],
            responses: vec![],
        });
        assert_eq!(hex(&bytes_of(fulfilled)), REAL_FULFILLED);
        assert_eq!(hex(&bytes_of(pending)), REAL_PENDING);
    }

    #[test]
    fn request_v2_has_the_real_discriminator_and_argument_layout() {
        let data = instruction::RequestV2 { seed: [9; 32] }.data();
        assert_eq!(hex(&data), REAL_REQUEST_V2);
    }

    #[test]
    fn the_pending_account_size_matches_the_real_program() {
        assert_eq!(8 + RandomnessV2::PENDING_SIZE, 749);
    }
}
