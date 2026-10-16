//! Writes (and checks) the exact bytes and account lists of every breaks instruction, the id
//! derivations, and sample account data, as JSON for the TypeScript keeper's tests. Does not
//! need the SBF build.

use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use breaks::{
    accounts, instruction,
    randomness::{draw_seed, request_address, request_id},
    state::{Break, BreakStatus, BreaksConfig, FreeWinner, PackTier, Spot, MAX_FREE_SPOTS, MAX_PACKS, MAX_TIERS},
    CreateBreakParams, InitializeParams, ProofStepArg,
};
use solana_address::Address;
use testkit::*;

fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}
fn config() -> Address {
    pda(&[breaks::CONFIG_SEED], &breaks::ID)
}
fn treasury_authority() -> Address {
    pda(&[breaks::TREASURY_AUTHORITY_SEED], &breaks::ID)
}
fn break_at(id: u64) -> Address {
    pda(&[breaks::BREAK_SEED, &id.to_le_bytes()], &breaks::ID)
}
fn escrow_of(b: &Address) -> Address {
    pda(&[breaks::ESCROW_SEED, b.as_ref()], &breaks::ID)
}
fn spot_at(b: &Address, index: u16) -> Address {
    pda(&[breaks::SPOT_SEED, b.as_ref(), &index.to_le_bytes()], &breaks::ID)
}
fn treasury_config() -> Address {
    pda(&[treasury::CONFIG_SEED], &treasury::ID)
}
fn subsidy_vault() -> Address {
    pda(&[treasury::SUBSIDY_VAULT_SEED], &treasury::ID)
}
fn holder_vault() -> Address {
    pda(&[treasury::HOLDER_VAULT_SEED], &treasury::ID)
}
fn programdata() -> Address {
    let loader: Address = UPGRADEABLE_LOADER.parse().unwrap();
    pda(&[breaks::ID.as_ref()], &loader)
}

fn arr32(n: u8) -> [u8; 32] {
    [n; 32]
}

/// An ORAO-style program id for the examples (the real one: it is a constant of the deployment).
fn orao() -> Address {
    "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y".parse().unwrap()
}

#[test]
fn breaks_instruction_vectors() {
    let token = litesvm_token::TOKEN_ID;
    let system = anchor_lang::system_program::ID;
    let (authority, admin, keeper, buyer, mint) = (pk(1), pk(2), pk(3), pk(4), pk(5));
    let (buyer_usdc, payer, owner_usdc, wallet) = (pk(6), pk(7), pk(8), pk(9));
    let break_id = 7u64;
    let b = break_at(break_id);
    let seed = arr32(0x5e);

    let mut cases: Vec<String> = Vec::new();

    cases.push(instruction_case(
        "breaks.initialize",
        &format!(
            "{{ \"authority\": \"{authority}\", \"usdcMint\": \"{mint}\", \"admin\": \"{admin}\", \"keeper\": \"{keeper}\", \"buyer\": \"{buyer}\", \"minWindowSecs\": \"21600\", \"maxWindowSecs\": \"86400\", \"maxPaidSpots\": 20, \"maxFreeSpots\": 6, \"randomnessProgram\": \"{}\", \"randomnessTimeoutSecs\": \"3600\" }}",
            orao()
        ),
        &instruction::Initialize {
            params: InitializeParams {
                admin,
                keeper,
                buyer,
                min_window_secs: 21_600,
                max_window_secs: 86_400,
                max_paid_spots: 20,
                max_free_spots: 6,
                randomness_program: orao(),
                randomness_timeout_secs: 3_600,
            },
        }
        .data(),
        &accounts::Initialize {
            authority,
            program: breaks::ID,
            program_data: programdata(),
            config: config(),
            treasury_config: treasury_config(),
            usdc_mint: mint,
            system_program: system,
        }
        .to_account_metas(None),
    ));

    let admin_only = || {
        accounts::AdminOnly {
            admin,
            config: config(),
        }
        .to_account_metas(None)
    };
    cases.push(instruction_case(
        "breaks.set_keeper",
        &format!("{{ \"admin\": \"{admin}\", \"keeper\": \"{keeper}\" }}"),
        &instruction::SetKeeper { keeper }.data(),
        &admin_only(),
    ));
    cases.push(instruction_case(
        "breaks.set_buyer",
        &format!("{{ \"admin\": \"{admin}\", \"buyer\": \"{buyer}\" }}"),
        &instruction::SetBuyer { buyer }.data(),
        &admin_only(),
    ));
    cases.push(instruction_case(
        "breaks.set_paused",
        &format!("{{ \"admin\": \"{admin}\", \"paused\": true }}"),
        &instruction::SetPaused { paused: true }.data(),
        &admin_only(),
    ));
    cases.push(instruction_case(
        "breaks.set_randomness",
        &format!(
            "{{ \"admin\": \"{admin}\", \"program\": \"{}\", \"timeoutSecs\": \"7200\" }}",
            orao()
        ),
        &instruction::SetRandomness {
            program: orao(),
            timeout_secs: 7_200,
        }
        .data(),
        &admin_only(),
    ));

    // A mixed break: 6 paid spots and 2 free ones, packs from three machines, cheapest first.
    cases.push(instruction_case(
        "breaks.create_break",
        &format!(
            "{{ \"keeper\": \"{keeper}\", \"usdcMint\": \"{mint}\", \"breakId\": \"{break_id}\", \"paidSpots\": 6, \"freeSpots\": 2, \"spotPrice\": \"20000000\", \"tiers\": [ {{ \"machine\": \"{}\", \"maxPrice\": \"10000000\" }}, {{ \"machine\": \"{}\", \"maxPrice\": \"25000000\" }}, {{ \"machine\": \"{}\", \"maxPrice\": \"50000000\" }} ], \"packs\": [0, 0, 0, 0, 1, 1, 2, 2], \"opensAt\": \"1800000000\", \"closesAt\": \"1800021600\" }}",
            hex(&arr32(0x71)),
            hex(&arr32(0x72)),
            hex(&arr32(0x73))
        ),
        &instruction::CreateBreak {
            params: CreateBreakParams {
                paid_spots: 6,
                free_spots: 2,
                spot_price: 20_000_000,
                tiers: vec![
                    PackTier { machine: arr32(0x71), max_price: 10_000_000 },
                    PackTier { machine: arr32(0x72), max_price: 25_000_000 },
                    PackTier { machine: arr32(0x73), max_price: 50_000_000 },
                ],
                packs: vec![0, 0, 0, 0, 1, 1, 2, 2],
                opens_at: 1_800_000_000,
                closes_at: 1_800_021_600,
            },
        }
        .data(),
        &accounts::CreateBreak {
            keeper,
            config: config(),
            break_: b,
            usdc_mint: mint,
            escrow: escrow_of(&b),
            treasury_authority: treasury_authority(),
            treasury_config: treasury_config(),
            subsidy_vault: subsidy_vault(),
            holder_vault: holder_vault(),
            treasury_program: treasury::ID,
            token_program: token,
            system_program: system,
        }
        .to_account_metas(None),
    ));

    cases.push(instruction_case(
        "breaks.buy_spot",
        &format!(
            "{{ \"buyer\": \"{buyer}\", \"buyerUsdc\": \"{buyer_usdc}\", \"breakId\": \"{break_id}\", \"index\": 3 }}"
        ),
        &instruction::BuySpot { index: 3 }.data(),
        &accounts::BuySpot {
            buyer,
            config: config(),
            break_: b,
            escrow: escrow_of(&b),
            buyer_usdc,
            spot: spot_at(&b, 3),
            token_program: token,
            system_program: system,
        }
        .to_account_metas(None),
    ));

    cases.push(instruction_case(
        "breaks.close_break",
        &format!("{{ \"breakId\": \"{break_id}\" }}"),
        &instruction::CloseBreak {}.data(),
        &accounts::CloseBreak { break_: b }.to_account_metas(None),
    ));

    let keeper_call = || {
        accounts::KeeperBreakCall {
            keeper,
            config: config(),
            break_: b,
        }
        .to_account_metas(None)
    };
    cases.push(instruction_case(
        "breaks.commit_eligibility",
        &format!(
            "{{ \"keeper\": \"{keeper}\", \"breakId\": \"{break_id}\", \"root\": \"{}\", \"totalWeight\": \"18446744073709551615\", \"entryCount\": 5, \"inputsHash\": \"{}\" }}",
            hex(&arr32(0x11)),
            hex(&arr32(0x22))
        ),
        &instruction::CommitEligibility {
            root: arr32(0x11),
            total_weight: u64::MAX,
            entry_count: 5,
            inputs_hash: arr32(0x22),
        }
        .data(),
        &keeper_call(),
    ));
    cases.push(instruction_case(
        "breaks.commit_pool",
        &format!(
            "{{ \"keeper\": \"{keeper}\", \"breakId\": \"{break_id}\", \"poolHash\": \"{}\", \"poolSize\": 12 }}",
            hex(&arr32(0x33))
        ),
        &instruction::CommitPool {
            pool_hash: arr32(0x33),
            pool_size: 12,
        }
        .data(),
        &keeper_call(),
    ));

    cases.push(instruction_case(
        "breaks.fund_purchases",
        &format!("{{ \"keeper\": \"{keeper}\", \"breakId\": \"{break_id}\", \"buyerUsdc\": \"{buyer_usdc}\" }}"),
        &instruction::FundPurchases {}.data(),
        &accounts::FundPurchases {
            keeper,
            config: config(),
            break_: b,
            escrow: escrow_of(&b),
            buyer_usdc,
            treasury_authority: treasury_authority(),
            treasury_config: treasury_config(),
            subsidy_vault: subsidy_vault(),
            holder_vault: holder_vault(),
            treasury_program: treasury::ID,
            token_program: token,
        }
        .to_account_metas(None),
    ));

    // Randomness: first request (no previous request), and a repeat with ORAO's token-fee accounts.
    let (network_state, vrf_treasury) = (pk(0xA1), pk(0xA2));
    let request = request_address(&orao(), &seed);
    let randomness_accounts = |previous: Address| {
        accounts::RequestRandomness {
            keeper,
            config: config(),
            break_: b,
            vrf_program: orao(),
            vrf_network_state: network_state,
            vrf_treasury,
            request,
            previous_request: previous,
            system_program: system,
        }
        .to_account_metas(None)
    };
    cases.push(instruction_case(
        "breaks.request_randomness",
        &format!(
            "{{ \"keeper\": \"{keeper}\", \"breakId\": \"{break_id}\", \"vrfProgram\": \"{}\", \"vrfNetworkState\": \"{network_state}\", \"vrfTreasury\": \"{vrf_treasury}\", \"seed\": \"{}\", \"previousRequest\": \"{system}\", \"extra\": [] }}",
            orao(),
            hex(&seed)
        ),
        &instruction::RequestRandomness {}.data(),
        &randomness_accounts(system),
    ));
    let previous = request_address(&orao(), &arr32(0x44));
    let mut with_extra = randomness_accounts(previous);
    with_extra.push(AccountMeta::new(pk(0xB1), false));
    with_extra.push(AccountMeta::new_readonly(token, false));
    cases.push(instruction_case(
        "breaks.request_randomness",
        &format!(
            "{{ \"keeper\": \"{keeper}\", \"breakId\": \"{break_id}\", \"vrfProgram\": \"{}\", \"vrfNetworkState\": \"{network_state}\", \"vrfTreasury\": \"{vrf_treasury}\", \"seed\": \"{}\", \"previousRequest\": \"{previous}\", \"extra\": [ {{ \"pubkey\": \"{}\", \"writable\": true }}, {{ \"pubkey\": \"{token}\", \"writable\": false }} ] }}",
            orao(),
            hex(&seed),
            pk(0xB1)
        ),
        &instruction::RequestRandomness {}.data(),
        &with_extra,
    ));

    cases.push(instruction_case(
        "breaks.settle_randomness",
        &format!("{{ \"breakId\": \"{break_id}\", \"request\": \"{request}\" }}"),
        &instruction::SettleRandomness {}.data(),
        &accounts::SettleRandomness {
            config: config(),
            break_: b,
            request,
        }
        .to_account_metas(None),
    ));

    let proof = [
        ProofStepArg {
            hash: arr32(0x01),
            sum: 5,
            sibling_is_left: true,
        },
        ProofStepArg {
            hash: arr32(0x02),
            sum: u64::MAX / 2,
            sibling_is_left: false,
        },
    ];
    cases.push(instruction_case(
        "breaks.claim_free_spot",
        &format!(
            "{{ \"payer\": \"{payer}\", \"breakId\": \"{break_id}\", \"index\": 1, \"wallet\": \"{wallet}\", \"weight\": \"123456789012345\", \"proof\": [ {{ \"hash\": \"{}\", \"sum\": \"5\", \"siblingIsLeft\": true }}, {{ \"hash\": \"{}\", \"sum\": \"{}\", \"siblingIsLeft\": false }} ] }}",
            hex(&arr32(0x01)),
            hex(&arr32(0x02)),
            u64::MAX / 2
        ),
        &instruction::ClaimFreeSpot { index: 1, wallet, weight: 123_456_789_012_345, proof: proof.to_vec() }.data(),
        &accounts::ClaimFreeSpot { payer, break_: b }.to_account_metas(None),
    ));

    cases.push(instruction_case(
        "breaks.cancel_break",
        &format!("{{ \"admin\": \"{admin}\", \"breakId\": \"{break_id}\" }}"),
        &instruction::CancelBreak {}.data(),
        &accounts::CancelBreak {
            admin,
            config: config(),
            break_: b,
            treasury_authority: treasury_authority(),
            treasury_config: treasury_config(),
            subsidy_vault: subsidy_vault(),
            holder_vault: holder_vault(),
            treasury_program: treasury::ID,
        }
        .to_account_metas(None),
    ));
    cases.push(instruction_case(
        "breaks.cancel_unfundable",
        &format!("{{ \"breakId\": \"{break_id}\" }}"),
        &instruction::CancelUnfundable {}.data(),
        &accounts::CancelUnfundable {
            break_: b,
            treasury_authority: treasury_authority(),
            treasury_config: treasury_config(),
            subsidy_vault: subsidy_vault(),
            holder_vault: holder_vault(),
            treasury_program: treasury::ID,
        }
        .to_account_metas(None),
    ));
    cases.push(instruction_case(
        "breaks.refund_spot",
        &format!("{{ \"breakId\": \"{break_id}\", \"index\": 3, \"ownerUsdc\": \"{owner_usdc}\" }}"),
        &instruction::RefundSpot {}.data(),
        &accounts::RefundSpot {
            break_: b,
            escrow: escrow_of(&b),
            spot: spot_at(&b, 3),
            owner_usdc,
            token_program: token,
        }
        .to_account_metas(None),
    ));

    // ---- derivations
    let (root, pool) = (arr32(0x11), arr32(0x33));
    cases.push(value_case(
        "breaks.request_id",
        &format!(
            "{{ \"break\": \"{b}\", \"attempt\": 2, \"eligibilityRoot\": \"{}\", \"poolHash\": \"{}\" }}",
            hex(&root),
            hex(&pool)
        ),
        &format!("{{ \"requestId\": \"{}\" }}", hex(&request_id(&b, 2, &root, &pool))),
    ));
    let answer: Vec<u8> = (0..64u8).collect();
    cases.push(value_case(
        "breaks.draw_seed",
        &format!("{{ \"answer\": \"{}\" }}", hex(&answer)),
        &format!(
            "{{ \"seed\": \"{}\" }}",
            hex(&draw_seed(&answer.clone().try_into().unwrap()))
        ),
    ));

    // ---- account data
    let mut free_winners = [FreeWinner::default(); MAX_FREE_SPOTS];
    free_winners[0] = FreeWinner {
        wallet: pk(0xC1),
        start: 10,
        weight: 20,
    };
    free_winners[1] = FreeWinner {
        wallet: pk(0xC2),
        start: 40,
        weight: u64::MAX / 3,
    };
    let mut sample_tiers = [PackTier::default(); MAX_TIERS];
    sample_tiers[0] = PackTier {
        machine: arr32(0x71),
        max_price: 10_000_000,
    };
    sample_tiers[1] = PackTier {
        machine: arr32(0x72),
        max_price: 25_000_000,
    };
    sample_tiers[2] = PackTier {
        machine: arr32(0x73),
        max_price: 50_000_000,
    };
    let mut sample_packs = [0u8; MAX_PACKS];
    sample_packs[..12].copy_from_slice(&[0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
    let sample_break = Break {
        id: 7,
        status: BreakStatus::Settled,
        paid_spots: 10,
        free_spots: 2,
        spot_price: 20_000_000,
        tier_count: 3,
        tiers: sample_tiers,
        packs: sample_packs,
        opens_at: 1_800_000_000,
        closes_at: 1_800_021_600,
        spots_sold: 8,
        locked_subsidy: 1,
        locked_holder: 2,
        eligibility_root: arr32(0x11),
        eligibility_total_weight: 1_200,
        eligibility_count: 5,
        eligibility_inputs_hash: arr32(0x22),
        pool_size: 10,
        pack_budget: 200_000_000,
        pool_hash: arr32(0x33),
        randomness_attempt: 1,
        randomness_request_id: arr32(0x5e),
        randomness_requested_at: 1_800_030_000,
        seed: arr32(0x99),
        seeded_at: 1_800_030_100,
        free_winner_count: 2,
        free_winners,
        bump: 254,
        escrow_bump: 253,
    };
    let account_bytes = |value: &dyn Fn(&mut Vec<u8>)| {
        let mut v = Vec::new();
        value(&mut v);
        v
    };
    let winners_json: Vec<String> = sample_break
        .free_winners
        .iter()
        .map(|w| {
            format!(
                "{{ \"wallet\": \"{}\", \"start\": \"{}\", \"weight\": \"{}\" }}",
                w.wallet, w.start, w.weight
            )
        })
        .collect();
    let break_json = format!(
        "{{ \"id\": \"7\", \"status\": \"Settled\", \"paidSpots\": 10, \"freeSpots\": 2, \"spotPrice\": \"20000000\", \"tiers\": [ {{ \"machine\": \"{}\", \"maxPrice\": \"10000000\" }}, {{ \"machine\": \"{}\", \"maxPrice\": \"25000000\" }}, {{ \"machine\": \"{}\", \"maxPrice\": \"50000000\" }} ], \"packs\": [0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2], \"opensAt\": \"1800000000\", \"closesAt\": \"1800021600\", \"spotsSold\": 8, \"lockedSubsidy\": \"1\", \"lockedHolder\": \"2\", \"eligibilityRoot\": \"{}\", \"eligibilityTotalWeight\": \"1200\", \"eligibilityCount\": 5, \"eligibilityInputsHash\": \"{}\", \"poolSize\": 10, \"packBudget\": \"200000000\", \"poolHash\": \"{}\", \"randomnessAttempt\": 1, \"randomnessRequestId\": \"{}\", \"randomnessRequestedAt\": \"1800030000\", \"seed\": \"{}\", \"seededAt\": \"1800030100\", \"freeWinnerCount\": 2, \"freeWinners\": [ {} ], \"bump\": 254, \"escrowBump\": 253 }}",
        hex(&arr32(0x71)),
        hex(&arr32(0x72)),
        hex(&arr32(0x73)),
        hex(&arr32(0x11)),
        hex(&arr32(0x22)),
        hex(&arr32(0x33)),
        hex(&arr32(0x5e)),
        hex(&arr32(0x99)),
        winners_json.join(", ")
    );
    cases.push(value_case(
        "breaks.account.Break",
        &format!(
            "{{ \"data\": \"{}\" }}",
            hex(&account_bytes(&|v| sample_break.try_serialize(v).unwrap()))
        ),
        &break_json,
    ));

    let sample_config = BreaksConfig {
        admin: pk(2),
        keeper: pk(3),
        buyer: pk(4),
        usdc_mint: pk(5),
        randomness_program: orao(),
        randomness_timeout_secs: 3_600,
        next_break_id: 8,
        min_window_secs: 21_600,
        max_window_secs: 86_400,
        max_paid_spots: 20,
        max_free_spots: 6,
        paused: true,
        bump: 255,
    };
    cases.push(value_case(
        "breaks.account.BreaksConfig",
        &format!("{{ \"data\": \"{}\" }}", hex(&account_bytes(&|v| sample_config.try_serialize(v).unwrap()))),
        &format!(
            "{{ \"admin\": \"{}\", \"keeper\": \"{}\", \"buyer\": \"{}\", \"usdcMint\": \"{}\", \"randomnessProgram\": \"{}\", \"randomnessTimeoutSecs\": \"3600\", \"nextBreakId\": \"8\", \"minWindowSecs\": \"21600\", \"maxWindowSecs\": \"86400\", \"maxPaidSpots\": 20, \"maxFreeSpots\": 6, \"paused\": true, \"bump\": 255 }}",
            pk(2),
            pk(3),
            pk(4),
            pk(5),
            orao()
        ),
    ));

    let sample_spot = Spot {
        break_id: 7,
        index: 3,
        owner: pk(9),
        paid: 20_000_000,
        refunded: true,
        bump: 252,
    };
    cases.push(value_case(
        "breaks.account.Spot",
        &format!("{{ \"data\": \"{}\" }}", hex(&account_bytes(&|v| sample_spot.try_serialize(v).unwrap()))),
        &format!("{{ \"breakId\": \"7\", \"index\": 3, \"owner\": \"{}\", \"paid\": \"20000000\", \"refunded\": true, \"bump\": 252 }}", pk(9)),
    ));

    check_vectors(
        concat!(env!("CARGO_MANIFEST_DIR"), "/instruction-vectors.json"),
        &format!(
            "{{ \"breaks\": \"{}\", \"treasury\": \"{}\" }}",
            breaks::ID,
            treasury::ID
        ),
        &cases,
    );
}
