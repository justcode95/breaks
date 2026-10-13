//! Randomness for the draw: ask ORAO once the eligibility root and the pool are committed, then
//! lock in the seed it produced. See `randomness.rs` for how the pieces fit.

use anchor_lang::prelude::*;

use crate::{
    errors::BreaksError,
    randomness::{self, RequestState, MAX_ATTEMPTS},
    state::{Break, BreakStatus, BreaksConfig},
    BREAK_SEED, CONFIG_SEED,
};

#[derive(Accounts)]
pub struct RequestRandomness<'info> {
    /// Pays ORAO's request fee and the rent of the request account.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper @ BreaksError::Unauthorized)]
    pub config: Account<'info, BreaksConfig>,
    #[account(mut, seeds = [BREAK_SEED, &break_.id.to_le_bytes()], bump = break_.bump)]
    pub break_: Box<Account<'info, Break>>,
    /// CHECK: the VRF program the admin appointed (ORAO in production).
    #[account(executable, address = config.randomness_program @ BreaksError::InvalidRandomnessRecord)]
    pub vrf_program: UncheckedAccount<'info>,
    /// CHECK: ORAO's network state; ORAO validates it.
    #[account(mut)]
    pub vrf_network_state: UncheckedAccount<'info>,
    /// CHECK: ORAO's fee treasury; ORAO validates it against its network state.
    #[account(mut)]
    pub vrf_treasury: UncheckedAccount<'info>,
    /// CHECK: the request account for this attempt; its address is checked in the handler.
    #[account(mut)]
    pub request: UncheckedAccount<'info>,
    /// CHECK: the request account of the previous attempt. Only read when repeating a request;
    /// otherwise any account (e.g. the system program) can be passed.
    pub previous_request: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> RequestRandomness<'info> {
    /// First request, or a repeat when ORAO never answered. Accounts after the declared ones are
    /// passed to ORAO (its token-fee accounts, if it charges in ORAO tokens).
    pub fn handle(&mut self, extra_accounts: &[AccountInfo<'info>]) -> Result<()> {
        let vrf = self.config.randomness_program;
        let b = &mut self.break_;
        let now = Clock::get()?.unix_timestamp;

        let attempt = match b.status {
            BreakStatus::PoolCommitted => 0u8,
            BreakStatus::RandomnessRequested => {
                // A repeat is only allowed while the previous request is still unanswered and
                // has timed out; an answered request must be settled instead, never replaced.
                require!(
                    now >= b
                        .randomness_requested_at
                        .saturating_add(self.config.randomness_timeout_secs),
                    BreaksError::RequestNotTimedOut
                );
                let previous =
                    randomness::read_request(&self.previous_request.to_account_info(), &vrf, &b.randomness_request_id)?;
                require!(previous == RequestState::Pending, BreaksError::AlreadyFulfilled);
                require!(b.randomness_attempt + 1 < MAX_ATTEMPTS, BreaksError::TooManyAttempts);
                b.randomness_attempt + 1
            }
            _ => return err!(BreaksError::WrongStatus),
        };

        let seed = randomness::request_id(&b.key(), attempt, &b.eligibility_root, &b.pool_hash);
        let expected = randomness::request_address(&vrf, &seed);
        require_keys_eq!(self.request.key(), expected, BreaksError::InvalidRandomnessRecord);

        b.randomness_attempt = attempt;
        b.randomness_request_id = seed;
        b.randomness_requested_at = now;
        b.status = BreakStatus::RandomnessRequested;
        let break_id = b.id;

        let request_info = self.request.to_account_info();
        if *request_info.owner == vrf && !request_info.data_is_empty() {
            // Someone else already asked ORAO for exactly this seed (anyone can, once the seed is
            // computable). That does not hurt: the seed only exists because of our commitments, so
            // ORAO's answer to it is just as unpredictable. Adopt the request instead of failing.
            randomness::read_request(&request_info, &vrf, &seed)?;
        } else {
            randomness::request_v2(
                &randomness::RequestV2Accounts {
                    vrf_program: &self.vrf_program.to_account_info(),
                    payer: &self.keeper.to_account_info(),
                    network_state: &self.vrf_network_state.to_account_info(),
                    treasury: &self.vrf_treasury.to_account_info(),
                    request: &request_info,
                    system_program: &self.system_program.to_account_info(),
                    extra: extra_accounts,
                },
                seed,
            )?;
            // ORAO must have created a request that is still waiting for its oracles.
            let created = randomness::read_request(&request_info, &vrf, &seed)?;
            require!(created == RequestState::Pending, BreaksError::InvalidRandomnessRecord);
        }

        emit!(RandomnessRequested {
            id: break_id,
            attempt,
            request_id: seed,
            request: expected
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SettleRandomness<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, BreaksConfig>,
    #[account(mut, seeds = [BREAK_SEED, &break_.id.to_le_bytes()], bump = break_.bump)]
    pub break_: Box<Account<'info, Break>>,
    /// CHECK: the request account of the current attempt; owner, address and seed are checked.
    pub request: UncheckedAccount<'info>,
}

impl SettleRandomness<'_> {
    /// Anyone can lock in the seed as soon as ORAO has answered.
    pub fn handle(&mut self) -> Result<()> {
        let b = &mut self.break_;
        b.require_status(BreakStatus::RandomnessRequested)?;
        let state = randomness::read_request(
            &self.request.to_account_info(),
            &self.config.randomness_program,
            &b.randomness_request_id,
        )?;
        let RequestState::Fulfilled(answer) = state else {
            return err!(BreaksError::RandomnessNotFulfilled);
        };

        let seed = randomness::draw_seed(&answer);
        b.seed = seed;
        b.seeded_at = Clock::get()?.unix_timestamp;
        // With no free spots there is nobody to draw.
        b.status = if b.free_winners_expected() == 0 {
            BreakStatus::Drawn
        } else {
            BreakStatus::Settled
        };

        emit!(RandomnessSettled {
            id: b.id,
            seed,
            request: self.request.key()
        });
        Ok(())
    }
}

#[event]
pub struct RandomnessRequested {
    pub id: u64,
    pub attempt: u8,
    pub request_id: [u8; 32],
    pub request: Pubkey,
}

#[event]
pub struct RandomnessSettled {
    pub id: u64,
    pub seed: [u8; 32],
    pub request: Pubkey,
}
