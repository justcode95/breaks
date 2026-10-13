use super::*;

/// Wallet number `i`: bytes sort in the same order as `i`.
fn wallet(i: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&i.to_be_bytes());
    w
}

fn leaves(weights: &[u64]) -> Vec<Leaf> {
    weights
        .iter()
        .enumerate()
        .map(|(i, w)| Leaf {
            wallet: wallet(i as u64 + 1),
            weight: *w,
        })
        .collect()
}

fn seed_of(n: u64) -> Hash {
    hashv(&[b"test-seed", &n.to_le_bytes()]).to_bytes()
}

/// Draws `k` winners one after the other, as the program does.
fn draw(seed: &Hash, leaves: &[Leaf], k: usize) -> Vec<(usize, u64, u64)> {
    draw_free_winners(seed, leaves, k)
        .unwrap()
        .iter()
        .map(|w| (w.leaf_index, w.start, w.weight))
        .collect()
}

// ---------------------------------------------------------------- the tree

#[test]
fn a_single_leaf_is_its_own_root() {
    let ls = leaves(&[42]);
    let tree = Tree::build(&ls).unwrap();
    assert_eq!(tree.root(), leaf_node(&ls[0]));
    assert!(tree.proof(0).unwrap().is_empty());
    let v = verify(&ls[0], &[]).unwrap();
    assert_eq!((v.root, v.start), (tree.root(), 0));
}

#[test]
fn every_proof_leads_to_the_root_and_shows_the_leafs_range() {
    for n in [1usize, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 33, 100] {
        let weights: Vec<u64> = (0..n as u64).map(|i| (i * 7 + 3) % 11 + 1).collect();
        let ls = leaves(&weights);
        let tree = Tree::build(&ls).unwrap();
        let total: u64 = weights.iter().sum();
        assert_eq!(tree.root().sum, total, "n = {n}");

        let mut expected_start = 0;
        for (i, leaf) in ls.iter().enumerate() {
            let proof = tree.proof(i).unwrap();
            let v = verify(leaf, &proof).unwrap();
            assert_eq!(v.root, tree.root(), "n = {n}, leaf {i}");
            assert_eq!(v.start, expected_start, "n = {n}, leaf {i}");
            expected_start += leaf.weight;
        }
        assert_eq!(expected_start, total);
    }
}

#[test]
fn a_carried_up_node_is_not_counted_twice() {
    // 3 leaves: the third has no sibling on the first level.
    let ls = leaves(&[10, 20, 30]);
    let tree = Tree::build(&ls).unwrap();
    assert_eq!(tree.root().sum, 60);
    assert_eq!(tree.proof(2).unwrap().len(), 1); // only the pair (leaf 0, leaf 1) is its sibling
}

#[test]
fn a_proof_does_not_work_for_a_different_leaf_weight_or_path() {
    let ls = leaves(&[5, 1, 100, 7, 3]);
    let tree = Tree::build(&ls).unwrap();
    let proof = tree.proof(2).unwrap();
    let root = tree.root();

    // wrong weight
    let heavier = Leaf {
        weight: ls[2].weight + 1,
        ..ls[2]
    };
    assert_ne!(verify(&heavier, &proof).unwrap().root, root);
    // wrong wallet
    let other = Leaf {
        wallet: wallet(99),
        ..ls[2]
    };
    assert_ne!(verify(&other, &proof).unwrap().root, root);
    // wrong side of a sibling
    let mut flipped = proof.clone();
    flipped[0].sibling_is_left = !flipped[0].sibling_is_left;
    assert_ne!(verify(&ls[2], &flipped).unwrap().root, root);
    // a sibling with a different sum
    let mut lied = proof.clone();
    lied[0].sibling.sum += 1;
    assert_ne!(verify(&ls[2], &lied).unwrap().root, root);
    // a shortened proof
    assert_ne!(verify(&ls[2], &proof[1..]).unwrap().root, root);
    // another leaf's proof
    assert_ne!(verify(&ls[2], &tree.proof(3).unwrap()).unwrap().root, root);
    // the real thing still works
    assert_eq!(verify(&ls[2], &proof).unwrap().root, root);
}

#[test]
fn a_leaf_cannot_pass_for_an_inner_node() {
    // Domain separation: an inner node's hash can never be presented as a leaf.
    let ls = leaves(&[5, 1]);
    let tree = Tree::build(&ls).unwrap();
    let fake_leaf = Leaf {
        wallet: [0; 32],
        weight: 6,
    };
    assert_ne!(leaf_node(&fake_leaf).hash, tree.root().hash);
    assert_ne!(
        leaf_node(&ls[0]).hash,
        parent(&leaf_node(&ls[0]), &leaf_node(&ls[1])).unwrap().hash
    );
}

#[test]
fn building_rejects_bad_input() {
    assert_eq!(Tree::build(&[]).err(), Some(DrawError::Empty));
    let mut unsorted = leaves(&[1, 2, 3]);
    unsorted.swap(0, 2);
    assert_eq!(Tree::build(&unsorted).err(), Some(DrawError::NotSortedOrDuplicate));
    let mut duplicate = leaves(&[1, 2, 3]);
    duplicate[1].wallet = duplicate[0].wallet;
    assert_eq!(Tree::build(&duplicate).err(), Some(DrawError::NotSortedOrDuplicate));
    assert_eq!(Tree::build(&leaves(&[1, 0, 3])).err(), Some(DrawError::ZeroWeight));
    assert_eq!(Tree::build(&leaves(&[u64::MAX, 1])).err(), Some(DrawError::Overflow));
    assert_eq!(
        Tree::build(&leaves(&[1])).unwrap().proof(1).err(),
        Some(DrawError::IndexOutOfRange)
    );
}

#[test]
fn verifying_rejects_zero_weight_and_absurdly_long_proofs() {
    let zero = Leaf {
        wallet: wallet(1),
        weight: 0,
    };
    assert_eq!(verify(&zero, &[]).err(), Some(DrawError::ZeroWeight));
    let step = ProofStep {
        sibling: Node { hash: [0; 32], sum: 1 },
        sibling_is_left: false,
    };
    let long = vec![step; MAX_PROOF_LEN + 1];
    assert_eq!(verify(&leaves(&[1])[0], &long).err(), Some(DrawError::ProofTooLong));
}

// ---------------------------------------------------------------- the draw

#[test]
fn the_same_inputs_always_give_the_same_position_and_every_input_matters() {
    let seed = seed_of(1);
    let base = free_position(&seed, 0, 1000, &[]).unwrap();
    assert_eq!(base, free_position(&seed, 0, 1000, &[]).unwrap());
    assert!(base < 1000);
    let all: Vec<u64> = (0..20u16)
        .map(|i| free_position(&seed, i, 1000, &[]).unwrap())
        .collect();
    assert!(
        all.iter().collect::<std::collections::HashSet<_>>().len() > 10,
        "index must change the draw"
    );
    let other: Vec<u64> = (0..20u16)
        .map(|i| free_position(&seed_of(2), i, 1000, &[]).unwrap())
        .collect();
    assert_ne!(all, other, "seed must change the draw");
}

#[test]
fn skipping_taken_ranges_maps_the_free_weight_onto_the_free_positions() {
    // Weight 10 with ranges [2,5) and [6,8) taken leaves the positions 0,1,5,8,9 free.
    let taken = [(2u64, 3u64), (6, 2)];
    let free: std::collections::BTreeSet<u64> = (0..2000u64)
        .map(|n| free_position(&seed_of(n), 0, 10, &taken).unwrap())
        .collect();
    assert_eq!(free.into_iter().collect::<Vec<_>>(), vec![0, 1, 5, 8, 9]);
    // The order the taken ranges are listed in does not matter.
    for n in 0..50 {
        assert_eq!(
            free_position(&seed_of(n), 0, 10, &taken).unwrap(),
            free_position(&seed_of(n), 0, 10, &[taken[1], taken[0]]).unwrap()
        );
    }
}

#[test]
fn drawing_everyone_gives_every_wallet_exactly_once_even_when_one_has_almost_all_the_weight() {
    // The case a "retry until it is a new wallet" rule can fail on.
    let ls = leaves(&[1, 1, u64::MAX / 4, 1, 1, 1]);
    for n in 0..200 {
        let winners = draw(&seed_of(n), &ls, ls.len());
        let mut who: Vec<usize> = winners.iter().map(|w| w.0).collect();
        who.sort();
        assert_eq!(who, (0..ls.len()).collect::<Vec<_>>(), "seed {n}");
    }
}

#[test]
fn winners_are_distinct_and_their_ranges_never_overlap() {
    let ls = leaves(&[10, 20, 5, 1, 1, 50, 3, 9, 100, 2]);
    for n in 0..300 {
        let winners = draw(&seed_of(n), &ls, 4);
        let mut who: Vec<usize> = winners.iter().map(|w| w.0).collect();
        who.sort();
        who.dedup();
        assert_eq!(who.len(), 4, "seed {n}");
    }
}

#[test]
fn nobody_left_to_draw_is_an_error() {
    assert_eq!(
        free_position(&seed_of(1), 0, 10, &[(0, 10)]).err(),
        Some(DrawError::NoRemainingWeight)
    );
    assert_eq!(
        free_position(&seed_of(1), 0, 0, &[]).err(),
        Some(DrawError::NoRemainingWeight)
    );
}

#[test]
fn the_first_winner_is_drawn_in_proportion_to_the_weights() {
    let ls = leaves(&[1, 2, 3, 4]);
    let trials = 20_000u64;
    let mut counts = [0u64; 4];
    for n in 0..trials {
        counts[draw(&seed_of(n), &ls, 1)[0].0] += 1;
    }
    for (i, w) in [1.0f64, 2.0, 3.0, 4.0].iter().enumerate() {
        let p = w / 10.0;
        let expected = p * trials as f64;
        let sigma = (trials as f64 * p * (1.0 - p)).sqrt();
        assert!(
            (counts[i] as f64 - expected).abs() < 5.0 * sigma,
            "leaf {i}: {} vs {expected}",
            counts[i]
        );
    }
}

// ---------------------------------------------------------------- assignment

#[test]
fn the_assignment_is_a_permutation_that_depends_on_the_seed() {
    assert_eq!(assignment(&seed_of(1), 0), Vec::<u16>::new());
    assert_eq!(assignment(&seed_of(1), 1), vec![0]);
    for n in [2usize, 5, 10, 50] {
        let perm = assignment(&seed_of(7), n);
        let mut sorted = perm.clone();
        sorted.sort();
        assert_eq!(sorted, (0..n as u16).collect::<Vec<_>>());
        assert_eq!(perm, assignment(&seed_of(7), n), "deterministic");
    }
    assert_ne!(assignment(&seed_of(1), 10), assignment(&seed_of(2), 10));
}

#[test]
fn every_card_is_equally_likely_to_land_on_the_first_spot() {
    let trials = 20_000u64;
    let mut counts = [0u64; 4];
    for n in 0..trials {
        counts[assignment(&seed_of(n), 4)[0] as usize] += 1;
    }
    let expected = trials as f64 / 4.0;
    let sigma = (trials as f64 * 0.25 * 0.75).sqrt();
    for (i, c) in counts.iter().enumerate() {
        assert!(
            (*c as f64 - expected).abs() < 5.0 * sigma,
            "card {i}: {c} vs {expected}"
        );
    }
}

// ---------------------------------------------------------------- vectors for other languages

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// One example with every output, as JSON. The TypeScript keeper and the verify tool must
/// reproduce all of it byte for byte.
fn case_json(name: &str, weights: &[u64], seed_label: &str, k: usize, assignment_n: usize) -> String {
    let ls = leaves(weights);
    let tree = Tree::build(&ls).unwrap();
    let total: u64 = weights.iter().sum();
    let seed = hashv(&[seed_label.as_bytes()]).to_bytes();

    let leaves_json: Vec<String> = ls
        .iter()
        .map(|l| format!("{{ \"wallet\": \"{}\", \"weight\": \"{}\" }}", hex(&l.wallet), l.weight))
        .collect();
    let proofs_json: Vec<String> = (0..ls.len())
        .map(|i| {
            let steps: Vec<String> = tree
                .proof(i)
                .unwrap()
                .iter()
                .map(|s| {
                    format!(
                        "{{ \"hash\": \"{}\", \"sum\": \"{}\", \"sibling_is_left\": {} }}",
                        hex(&s.sibling.hash),
                        s.sibling.sum,
                        s.sibling_is_left
                    )
                })
                .collect();
            format!("[{}]", steps.join(", "))
        })
        .collect();

    let winners = draw_free_winners(&seed, &ls, k).unwrap();
    let winners_json: Vec<String> = winners
        .iter()
        .map(|w| {
            format!(
                "{{ \"leaf\": {}, \"start\": \"{}\", \"weight\": \"{}\", \"position\": \"{}\" }}",
                w.leaf_index, w.start, w.weight, w.position
            )
        })
        .collect();
    let perm: Vec<String> = assignment(&seed, assignment_n).iter().map(|x| x.to_string()).collect();

    // u64 values are strings: JSON numbers above 2^53 do not survive JavaScript.
    format!(
        "    {{\n      \"name\": \"{name}\",\n      \"leaves\": [{}],\n      \"root\": {{ \"hash\": \"{}\", \"sum\": \"{}\" }},\n      \"total\": \"{total}\",\n      \"proofs\": [{}],\n      \"seed\": \"{}\",\n      \"free_winners\": [{}],\n      \"assignment_n\": {assignment_n},\n      \"assignment\": [{}]\n    }}",
        leaves_json.join(", "),
        hex(&tree.root().hash),
        tree.root().sum,
        proofs_json.join(", "),
        hex(&seed),
        winners_json.join(", "),
        perm.join(", ")
    )
}

fn vectors_json() -> String {
    let big = u64::MAX / 4;
    let many: Vec<u64> = (0..37u64).map(|i| (i * 13 + 5) % 17 + 1).collect();
    let cases = [
        case_json("one leaf", &[42], "v-one", 1, 1),
        case_json("two leaves", &[3, 9], "v-two", 2, 2),
        case_json(
            "odd count carries a node up",
            &[5, 1, 100, 7, 3, 50, 2],
            "vector-seed",
            3,
            10,
        ),
        case_json("power of two", &[4, 8, 15, 16, 23, 42, 7, 1], "v-eight", 4, 8),
        case_json(
            "one wallet holds almost everything",
            &[1, 1, big, 1, 1, 1],
            "v-whale",
            6,
            6,
        ),
        case_json(
            "weights above 2^53",
            &[9_007_199_254_740_993, 3, big, 11],
            "v-large",
            3,
            5,
        ),
        case_json("many leaves", &many, "v-many", 5, 33),
    ];
    format!(
        "{{\n  \"comment\": \"Generated by draw-core (cargo test -p draw-core, UPDATE_VECTORS=1 to regenerate). Other implementations must reproduce every value. 64-bit numbers are strings.\",\n  \"cases\": [\n{}\n  ]\n}}\n",
        cases.join(",\n")
    )
}

#[test]
fn the_published_test_vectors_match_this_implementation() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors.json");
    let generated = vectors_json();
    if std::env::var("UPDATE_VECTORS").is_ok() {
        std::fs::write(path, &generated).unwrap();
    }
    let committed =
        std::fs::read_to_string(path).unwrap_or_else(|_| panic!("{path} is missing; run with UPDATE_VECTORS=1"));
    assert_eq!(
        committed, generated,
        "vectors.json is out of date (UPDATE_VECTORS=1 to regenerate)"
    );
}
