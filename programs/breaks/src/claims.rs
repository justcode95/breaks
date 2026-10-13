//! Free-spot winners. Once the seed is final, anyone can submit the winners, one at a time and in
//! order, with a proof from the published eligibility tree. The program checks that the wallet is
//! exactly the one the draw picks (see the `draw-core` crate), so the keeper cannot choose winners.

use anchor_lang::prelude::*;
use draw_core::{free_position, verify, Leaf, Node, ProofStep};

use crate::{
    errors::BreaksError,
    state::{Break, BreakStatus, FreeWinner},
    BREAK_SEED,
};

/// One step of a proof, as sent in the instruction data.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ProofStepArg {
    pub hash: [u8; 32],
    pub sum: u64,
    pub sibling_is_left: bool,
}

impl From<ProofStepArg> for ProofStep {
    fn from(a: ProofStepArg) -> Self {
        ProofStep {
            sibling: Node {
                hash: a.hash,
                sum: a.sum,
            },
            sibling_is_left: a.sibling_is_left,
        }
    }
}

#[derive(Accounts)]
pub struct ClaimFreeSpot<'info> {
    /// Anyone; pays the transaction fee only.
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BREAK_SEED, &break_.id.to_le_bytes()], bump = break_.bump)]
    pub break_: Box<Account<'info, Break>>,
}

impl ClaimFreeSpot<'_> {
    pub fn handle(&mut self, index: u8, wallet: Pubkey, weight: u64, proof: Vec<ProofStepArg>) -> Result<()> {
        let b = &mut self.break_;
        b.require_status(BreakStatus::Settled)?;
        require!(
            index == b.free_winner_count && u16::from(index) < b.free_winners_expected(),
            BreaksError::WrongClaimIndex
        );

        // Where the draw lands for this winner, skipping the ranges of the winners before.
        let taken: Vec<(u64, u64)> = b.free_winners[..usize::from(index)]
            .iter()
            .map(|w| (w.start, w.weight))
            .collect();
        let position = free_position(&b.seed, u16::from(index), b.eligibility_total_weight, &taken)
            .map_err(|_| error!(BreaksError::InvalidProof))?;

        // The proof ties the wallet and its weight to the committed root and shows its range.
        let proof: Vec<ProofStep> = proof.into_iter().map(Into::into).collect();
        let leaf = Leaf {
            wallet: wallet.to_bytes(),
            weight,
        };
        let verified = verify(&leaf, &proof).map_err(|_| error!(BreaksError::InvalidProof))?;
        require!(
            verified.root.hash == b.eligibility_root && verified.root.sum == b.eligibility_total_weight,
            BreaksError::InvalidProof
        );

        let end = verified.start.checked_add(weight).ok_or(BreaksError::InvalidProof)?;
        require!(
            verified.start <= position && position < end,
            BreaksError::NotTheDrawnWinner
        );
        // The ranges of different wallets cannot overlap, so this only trips on a tree that lists
        // the same wallet twice.
        require!(
            !b.free_winners[..usize::from(index)].iter().any(|w| w.wallet == wallet),
            BreaksError::WinnerAlreadyDrawn
        );

        b.free_winners[usize::from(index)] = FreeWinner {
            wallet,
            start: verified.start,
            weight,
        };
        b.free_winner_count += 1;
        if u16::from(b.free_winner_count) == b.free_winners_expected() {
            b.status = BreakStatus::Drawn;
        }

        emit!(FreeWinnerClaimed {
            id: b.id,
            index,
            wallet,
            weight,
            position
        });
        Ok(())
    }
}

#[event]
pub struct FreeWinnerClaimed {
    pub id: u64,
    pub index: u8,
    pub wallet: Pubkey,
    pub weight: u64,
    pub position: u64,
}
