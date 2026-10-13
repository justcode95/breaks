//! The draw, as pure functions. Everything here is deterministic and public, so anyone can
//! recompute it from the published eligibility list and the on-chain seed.
//!
//! Three pieces (the byte-exact definitions are tested against `vectors.json`, which the
//! TypeScript keeper and the verify tool must reproduce):
//!
//! 1. A **Merkle sum tree** over the eligible wallets. Leaves are sorted by wallet address; each
//!    node commits to its hash *and* the sum of the weights below it. A proof for one leaf
//!    therefore also proves the leaf's weight range `[start, start + weight)` inside
//!    `[0, total_weight)`, so the keeper cannot hand-craft overlapping or oversized ranges.
//! 2. **Free-spot winners, drawn without replacement.** Winner `i` is a uniform point in the
//!    weight that is still free after winners `0..i` were removed; mapped back to the full range
//!    by skipping the ranges of earlier winners. It always finds a new wallet, however skewed the
//!    weights are (a "retry until new" rule could fail when one wallet has almost all the weight).
//! 3. **Card to spot assignment**: a Fisher-Yates shuffle driven by the seed.
//!
//! Hash function: SHA-256 (syscall on Solana).

use solana_sha256_hasher::hashv;

pub type Hash = [u8; 32];

/// Prefix of a leaf hash (domain separation from inner nodes).
pub const LEAF_TAG: u8 = 0x00;
/// Prefix of an inner node hash.
pub const NODE_TAG: u8 = 0x01;
/// Longest proof accepted (a tree of 2^40 leaves). Real proofs are far shorter.
pub const MAX_PROOF_LEN: usize = 40;

const FREE_DOMAIN: &[u8] = b"breaks:free:v1";
const ITEMS_DOMAIN: &[u8] = b"breaks:items:v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawError {
    /// A tree needs at least one leaf.
    Empty,
    /// Leaves must be sorted by wallet, strictly increasing (so no wallet appears twice).
    NotSortedOrDuplicate,
    /// Every leaf needs a weight above zero.
    ZeroWeight,
    Overflow,
    ProofTooLong,
    /// All of the weight is already taken, so there is nobody left to draw.
    NoRemainingWeight,
    IndexOutOfRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Leaf {
    pub wallet: [u8; 32],
    pub weight: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Node {
    pub hash: Hash,
    pub sum: u64,
}

/// One step of a proof: the sibling subtree and on which side it sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProofStep {
    pub sibling: Node,
    pub sibling_is_left: bool,
}

/// `H(0x00 || wallet || weight_le)`; the sum of a leaf is its weight.
pub fn leaf_node(leaf: &Leaf) -> Node {
    Node {
        hash: hashv(&[&[LEAF_TAG], &leaf.wallet, &leaf.weight.to_le_bytes()]).to_bytes(),
        sum: leaf.weight,
    }
}

/// `H(0x01 || left.hash || left.sum_le || right.hash || right.sum_le)`, sum = left + right.
pub fn parent(left: &Node, right: &Node) -> Result<Node, DrawError> {
    let sum = left.sum.checked_add(right.sum).ok_or(DrawError::Overflow)?;
    let hash = hashv(&[
        &[NODE_TAG],
        &left.hash,
        &left.sum.to_le_bytes(),
        &right.hash,
        &right.sum.to_le_bytes(),
    ])
    .to_bytes();
    Ok(Node { hash, sum })
}

/// A tree built by the keeper (and by tests). The program only ever verifies proofs.
pub struct Tree {
    levels: Vec<Vec<Node>>,
}

impl Tree {
    /// `leaves` must be sorted by wallet (strictly increasing) with weights above zero.
    /// An odd node at the end of a level is carried up unchanged (never duplicated, which would
    /// count its weight twice).
    pub fn build(leaves: &[Leaf]) -> Result<Tree, DrawError> {
        if leaves.is_empty() {
            return Err(DrawError::Empty);
        }
        if leaves.windows(2).any(|w| w[0].wallet >= w[1].wallet) {
            return Err(DrawError::NotSortedOrDuplicate);
        }
        if leaves.iter().any(|l| l.weight == 0) {
            return Err(DrawError::ZeroWeight);
        }
        let mut levels = vec![leaves.iter().map(leaf_node).collect::<Vec<_>>()];
        while levels.last().is_some_and(|l| l.len() > 1) {
            let current = levels.last().unwrap();
            let mut next = Vec::with_capacity(current.len().div_ceil(2));
            for pair in current.chunks(2) {
                next.push(match pair {
                    [left, right] => parent(left, right)?,
                    [only] => *only,
                    _ => unreachable!(),
                });
            }
            levels.push(next);
        }
        Ok(Tree { levels })
    }

    pub fn root(&self) -> Node {
        self.levels.last().unwrap()[0]
    }

    pub fn leaf_count(&self) -> usize {
        self.levels[0].len()
    }

    /// Proof for the leaf at `index` (its position in the sorted leaves).
    pub fn proof(&self, index: usize) -> Result<Vec<ProofStep>, DrawError> {
        if index >= self.leaf_count() {
            return Err(DrawError::IndexOutOfRange);
        }
        let mut idx = index;
        let mut steps = Vec::new();
        for level in &self.levels[..self.levels.len() - 1] {
            let sibling = idx ^ 1;
            if sibling < level.len() {
                steps.push(ProofStep {
                    sibling: level[sibling],
                    sibling_is_left: sibling < idx,
                });
            } // else: this node was carried up, no sibling at this level
            idx /= 2;
        }
        Ok(steps)
    }
}

/// What a proof shows.
#[derive(Debug, PartialEq, Eq)]
pub struct Verified {
    /// The root the leaf and proof lead to; compare it with the committed root.
    pub root: Node,
    /// Where the leaf's range starts: the sum of everything to its left.
    pub start: u64,
}

/// Recomputes the root from a leaf and its proof. The leaf then owns `[start, start + weight)`.
pub fn verify(leaf: &Leaf, proof: &[ProofStep]) -> Result<Verified, DrawError> {
    if proof.len() > MAX_PROOF_LEN {
        return Err(DrawError::ProofTooLong);
    }
    if leaf.weight == 0 {
        return Err(DrawError::ZeroWeight);
    }
    let mut node = leaf_node(leaf);
    let mut start = 0u64;
    for step in proof {
        node = if step.sibling_is_left {
            start = start.checked_add(step.sibling.sum).ok_or(DrawError::Overflow)?;
            parent(&step.sibling, &node)?
        } else {
            parent(&node, &step.sibling)?
        };
    }
    Ok(Verified { root: node, start })
}

/// First 16 bytes of a hash as a little-endian number, reduced modulo `modulus` (above zero). The
/// bias is below 2^-64 for the moduli used here.
pub fn reduce(hash: &Hash, modulus: u128) -> u128 {
    u128::from_le_bytes(hash[..16].try_into().unwrap()) % modulus
}

/// The position in `[0, total_weight)` that decides free-spot winner `index`.
///
/// `taken` holds the `(start, weight)` ranges of the winners drawn before (any order). The draw
/// is uniform over the weight that is still free, then mapped back to the full range by skipping
/// the taken ranges. The wallet whose range contains the returned position is the winner.
pub fn free_position(seed: &Hash, index: u16, total_weight: u64, taken: &[(u64, u64)]) -> Result<u64, DrawError> {
    let removed = taken
        .iter()
        .try_fold(0u64, |acc, (_, w)| acc.checked_add(*w))
        .ok_or(DrawError::Overflow)?;
    let remaining = total_weight
        .checked_sub(removed)
        .filter(|r| *r > 0)
        .ok_or(DrawError::NoRemainingWeight)?;

    let hash = hashv(&[FREE_DOMAIN, seed, &index.to_le_bytes()]).to_bytes();
    let mut position = reduce(&hash, u128::from(remaining)) as u64;

    let mut holes = taken.to_vec();
    holes.sort_by_key(|(start, _)| *start);
    for (start, weight) in holes {
        if position >= start {
            position = position.checked_add(weight).ok_or(DrawError::Overflow)?;
        }
    }
    Ok(position)
}

/// A drawn free-spot winner, found by scanning the leaves (what the keeper does to know whom to
/// submit; the program only checks).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrawnWinner {
    /// Position of the winner's leaf in the sorted leaves.
    pub leaf_index: usize,
    /// Where the winner's range starts, and its weight.
    pub start: u64,
    pub weight: u64,
    /// The drawn position inside that range.
    pub position: u64,
}

/// The `k` free-spot winners for `seed`, drawn one after the other without replacement.
/// `leaves` are the eligible wallets sorted by wallet, as committed in the tree.
pub fn draw_free_winners(seed: &Hash, leaves: &[Leaf], k: usize) -> Result<Vec<DrawnWinner>, DrawError> {
    let total = leaves
        .iter()
        .try_fold(0u64, |acc, l| acc.checked_add(l.weight))
        .ok_or(DrawError::Overflow)?;
    let mut taken: Vec<(u64, u64)> = Vec::with_capacity(k);
    let mut winners = Vec::with_capacity(k);
    for i in 0..k {
        let position = free_position(
            seed,
            u16::try_from(i).map_err(|_| DrawError::IndexOutOfRange)?,
            total,
            &taken,
        )?;
        let mut start = 0u64;
        let mut found = None;
        for (leaf_index, leaf) in leaves.iter().enumerate() {
            if position < start + leaf.weight {
                found = Some(DrawnWinner {
                    leaf_index,
                    start,
                    weight: leaf.weight,
                    position,
                });
                break;
            }
            start += leaf.weight;
        }
        let winner = found.ok_or(DrawError::IndexOutOfRange)?;
        taken.push((winner.start, winner.weight));
        winners.push(winner);
    }
    Ok(winners)
}

/// Which card goes to which spot. Cards are the pool sorted by card mint; spots are ordered paid
/// spots by purchase order, then free spots in draw order. Returns `perm` where spot `s` gets
/// the card at index `perm[s]` of the sorted pool. Fisher-Yates from the back:
/// `j = H("breaks:items:v1" || seed || k_le) mod (k + 1)`, swap `perm[k]` and `perm[j]`.
pub fn assignment(seed: &Hash, n: usize) -> Vec<u16> {
    assert!(n <= usize::from(u16::MAX), "pool too large");
    let mut perm: Vec<u16> = (0..n as u16).collect();
    for k in (1..n).rev() {
        let hash = hashv(&[ITEMS_DOMAIN, seed, &(k as u16).to_le_bytes()]).to_bytes();
        let j = reduce(&hash, (k + 1) as u128) as usize;
        perm.swap(k, j);
    }
    perm
}

#[cfg(test)]
mod tests;
