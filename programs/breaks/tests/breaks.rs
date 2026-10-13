//! On-chain tests for the breaks program. Both programs run inside LiteSVM, so the treasury
//! locking, pay-outs and every account check are the real thing (see `testkit`).
//!
//! Needs both SBF builds first:
//! `cargo build-sbf --manifest-path programs/treasury/Cargo.toml` and the same for `breaks`.

use anchor_lang::{solana_program::instruction::Instruction, AnchorDeserialize, InstructionData, ToAccountMetas};
use breaks::{
    errors::BreaksError,
    randomness::{draw_seed, parse_request, request_address, request_id as derive_request_id, RequestState},
    state::{Break, BreakStatus, BreaksConfig, Spot},
    BreakCancelled, BreakClosed, BreakCreated, CreateBreakParams, EligibilityCommitted, PoolCommitted, PurchasesFunded,
    RandomnessRequested, RandomnessSettled, SpotBought, SpotRefunded,
};
use litesvm::LiteSVM;
use litesvm_token::{
    get_spl_account, spl_token::state::Account as TokenAccountState, CreateAssociatedTokenAccount, CreateMint, MintTo,
};
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;
use testkit::*;
use treasury::errors::TreasuryError;

const T0: i64 = 1_800_000_000;
const HOUR: i64 = 3600;

struct Env {
    svm: LiteSVM,
    /// Upgrade authority of both programs.
    authority: Keypair,
    treasury_admin: Keypair,
    admin: Keypair,
    keeper: Keypair,
    /// The pack buyer wallet and its USDC account.
    buyer: Keypair,
    buyer_usdc: Address,
    mint: Address,
    breaks_programdata: Address,
}

fn code(e: BreaksError) -> u32 {
    ERROR_CODE_OFFSET + e as u32
}

fn treasury_code(e: TreasuryError) -> u32 {
    ERROR_CODE_OFFSET + e as u32
}

fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}

fn breaks_config() -> Address {
    pda(&[breaks::CONFIG_SEED], &breaks::ID)
}
fn treasury_authority() -> Address {
    pda(&[breaks::TREASURY_AUTHORITY_SEED], &breaks::ID)
}
fn break_pda(id: u64) -> Address {
    pda(&[breaks::BREAK_SEED, &id.to_le_bytes()], &breaks::ID)
}
fn escrow_pda(break_: &Address) -> Address {
    pda(&[breaks::ESCROW_SEED, break_.as_ref()], &breaks::ID)
}
fn spot_pda(break_: &Address, index: u16) -> Address {
    pda(&[breaks::SPOT_SEED, break_.as_ref(), &index.to_le_bytes()], &breaks::ID)
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

/// Stand-ins for ORAO's network state and fee treasury (the mock ignores them).
fn vrf_network_state() -> Address {
    Address::new_from_array([0xA1; 32])
}
fn vrf_treasury() -> Address {
    Address::new_from_array([0xA2; 32])
}

fn ix(program_id: Address, accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

/// 10 paid spots at $20 for $25 packs plus 2 free spots, open for 6 hours from `T0`.
fn params() -> CreateBreakParams {
    CreateBreakParams {
        paid_spots: 10,
        free_spots: 2,
        spot_price: 20 * USDC,
        max_pack_price: 25 * USDC,
        pack_machine: [7; 32],
        opens_at: T0,
        closes_at: T0 + 6 * HOUR,
    }
}

impl Env {
    /// Both programs deployed, treasury initialized with the breaks program as controller and
    /// funded with 1000 USDC (700 subsidy / 300 holder). Breaks itself is not initialized yet.
    fn base() -> Self {
        let mut svm = LiteSVM::new();
        let [authority, treasury_admin, admin, keeper, buyer] = std::array::from_fn(|_| Keypair::new());
        for k in [&authority, &treasury_admin, &admin, &keeper, &buyer] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        set_unix_time(&mut svm, T0);

        let treasury_programdata = deploy(&mut svm, treasury::ID, "treasury", &authority.pubkey());
        let breaks_programdata = deploy(&mut svm, breaks::ID, "breaks", &authority.pubkey());
        deploy(&mut svm, mock_orao::ID, "mock_orao", &authority.pubkey());
        let mint = CreateMint::new(&mut svm, &authority).decimals(6).send().unwrap();
        let buyer_usdc = CreateAssociatedTokenAccount::new(&mut svm, &authority, &mint)
            .owner(&buyer.pubkey())
            .send()
            .unwrap();
        let mut env = Env {
            svm,
            authority,
            treasury_admin,
            admin,
            keeper,
            buyer,
            buyer_usdc,
            mint,
            breaks_programdata,
        };

        // Treasury: initialize, appoint the breaks program as controller, deposit 1000 USDC.
        let init = ix(
            treasury::ID,
            treasury::accounts::Initialize {
                authority: env.authority.pubkey(),
                program: treasury::ID,
                program_data: treasury_programdata,
                config: treasury_config(),
                usdc_mint: env.mint,
                subsidy_vault: subsidy_vault(),
                holder_vault: holder_vault(),
                token_program: litesvm_token::TOKEN_ID,
                system_program: anchor_lang::system_program::ID,
            },
            treasury::instruction::Initialize {
                params: treasury::InitializeParams {
                    admin: env.treasury_admin.pubkey(),
                    subsidy_bps: 7_000,
                    holder_bps: 3_000,
                },
            },
        );
        env.send_as_authority(&[init]).unwrap();
        let set_controller = ix(
            treasury::ID,
            treasury::accounts::SetController {
                admin: env.treasury_admin.pubkey(),
                config: treasury_config(),
            },
            treasury::instruction::SetController {
                controller: treasury_authority(),
            },
        );
        let treasury_admin = env.treasury_admin.insecure_clone();
        send(&mut env.svm, &treasury_admin, &[], &[set_controller]).unwrap();

        let (funder, funder_usdc) = env.user(1_000 * USDC);
        let deposit = ix(
            treasury::ID,
            treasury::accounts::DepositFees {
                depositor: funder.pubkey(),
                depositor_usdc: funder_usdc,
                config: treasury_config(),
                subsidy_vault: subsidy_vault(),
                holder_vault: holder_vault(),
                token_program: litesvm_token::TOKEN_ID,
            },
            treasury::instruction::DepositFees { amount: 1_000 * USDC },
        );
        send(&mut env.svm, &funder, &[], &[deposit]).unwrap();
        env
    }

    fn initialize_ix(&self, signer: &Address, program_data: Address) -> Instruction {
        ix(
            breaks::ID,
            breaks::accounts::Initialize {
                authority: *signer,
                program: breaks::ID,
                program_data,
                config: breaks_config(),
                treasury_config: treasury_config(),
                usdc_mint: self.mint,
                system_program: anchor_lang::system_program::ID,
            },
            breaks::instruction::Initialize {
                params: breaks::InitializeParams {
                    admin: self.admin.pubkey(),
                    keeper: self.keeper.pubkey(),
                    buyer: self.buyer.pubkey(),
                    min_window_secs: 6 * HOUR,
                    max_window_secs: 24 * HOUR,
                    max_paid_spots: 20,
                    max_free_spots: 6,
                    randomness_program: mock_orao::ID,
                    randomness_timeout_secs: HOUR,
                },
            },
        )
    }

    /// `base()` plus an initialized breaks program.
    fn ready() -> Self {
        let mut env = Self::base();
        let init = env.initialize_ix(&env.authority.pubkey(), env.breaks_programdata);
        env.send_as_authority(&[init]).unwrap();
        env
    }

    fn send_as_authority(&mut self, ixs: &[Instruction]) -> Sent {
        let authority = self.authority.insecure_clone();
        send(&mut self.svm, &authority, &[], ixs)
    }

    /// A funded wallet with a USDC account holding `amount`.
    fn user(&mut self, amount: u64) -> (Keypair, Address) {
        let wallet = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), 10_000_000_000).unwrap();
        let authority = self.authority.insecure_clone();
        let ata = CreateAssociatedTokenAccount::new(&mut self.svm, &authority, &self.mint)
            .owner(&wallet.pubkey())
            .send()
            .unwrap();
        if amount > 0 {
            MintTo::new(&mut self.svm, &authority, &self.mint, &ata, amount)
                .send()
                .unwrap();
        }
        (wallet, ata)
    }

    fn balance(&self, account: &Address) -> u64 {
        get_spl_account::<TokenAccountState>(&self.svm, account).unwrap().amount
    }

    fn read<T: AnchorDeserialize>(&self, address: &Address) -> T {
        let data = self
            .svm
            .get_account(address)
            .unwrap_or_else(|| panic!("no account {address}"))
            .data;
        T::deserialize(&mut &data[8..]).unwrap()
    }

    fn config(&self) -> BreaksConfig {
        self.read(&breaks_config())
    }
    fn brk(&self, id: u64) -> Break {
        self.read(&break_pda(id))
    }
    fn locked(&self) -> (u64, u64) {
        let c: treasury::state::Config = self.read(&treasury_config());
        (c.locked_subsidy, c.locked_holder)
    }

    fn create_break_ix(&self, signer: &Address, p: CreateBreakParams) -> Instruction {
        let id = self.config().next_break_id;
        let break_ = break_pda(id);
        ix(
            breaks::ID,
            breaks::accounts::CreateBreak {
                keeper: *signer,
                config: breaks_config(),
                break_,
                usdc_mint: self.mint,
                escrow: escrow_pda(&break_),
                treasury_authority: treasury_authority(),
                treasury_config: treasury_config(),
                subsidy_vault: subsidy_vault(),
                holder_vault: holder_vault(),
                treasury_program: treasury::ID,
                token_program: litesvm_token::TOKEN_ID,
                system_program: anchor_lang::system_program::ID,
            },
            breaks::instruction::CreateBreak { params: p },
        )
    }

    fn create_break_with(&mut self, p: CreateBreakParams) -> Sent {
        let keeper = self.keeper.insecure_clone();
        let i = self.create_break_ix(&keeper.pubkey(), p);
        send(&mut self.svm, &keeper, &[], &[i])
    }

    /// Creates the default break and returns its id.
    fn create_break(&mut self) -> u64 {
        let id = self.config().next_break_id;
        self.create_break_with(params()).unwrap();
        id
    }

    fn buy_spot(&mut self, who: &Keypair, who_usdc: Address, id: u64, index: u16) -> Sent {
        let break_ = break_pda(id);
        let i = ix(
            breaks::ID,
            breaks::accounts::BuySpot {
                buyer: who.pubkey(),
                config: breaks_config(),
                break_,
                escrow: escrow_pda(&break_),
                buyer_usdc: who_usdc,
                spot: spot_pda(&break_, index),
                token_program: litesvm_token::TOKEN_ID,
                system_program: anchor_lang::system_program::ID,
            },
            breaks::instruction::BuySpot { index },
        );
        send(&mut self.svm, who, &[], &[i])
    }

    /// Buys the next free spot for a brand-new user.
    fn sell_one(&mut self, id: u64) -> (Keypair, Address) {
        let (who, ata) = self.user(20 * USDC);
        let index = self.brk(id).spots_sold;
        self.buy_spot(&who, ata, id, index).unwrap();
        (who, ata)
    }

    fn close(&mut self, who: &Keypair, id: u64) -> Sent {
        let i = ix(
            breaks::ID,
            breaks::accounts::CloseBreak { break_: break_pda(id) },
            breaks::instruction::CloseBreak {},
        );
        send(&mut self.svm, who, &[], &[i])
    }

    fn keeper_call(&self, signer: &Address, id: u64) -> breaks::accounts::KeeperBreakCall {
        breaks::accounts::KeeperBreakCall {
            keeper: *signer,
            config: breaks_config(),
            break_: break_pda(id),
        }
    }

    fn commit_eligibility_as(&mut self, who: &Keypair, id: u64, weight: u64, count: u32) -> Sent {
        let i = ix(
            breaks::ID,
            self.keeper_call(&who.pubkey(), id),
            breaks::instruction::CommitEligibility {
                root: [1; 32],
                total_weight: weight,
                entry_count: count,
                inputs_hash: [2; 32],
            },
        );
        send(&mut self.svm, who, &[], &[i])
    }

    fn commit_eligibility(&mut self, id: u64, weight: u64, count: u32) -> Sent {
        let keeper = self.keeper.insecure_clone();
        self.commit_eligibility_as(&keeper, id, weight, count)
    }

    fn fund_ix(&self, signer: &Address, id: u64, buyer_usdc: Address) -> Instruction {
        let break_ = break_pda(id);
        ix(
            breaks::ID,
            breaks::accounts::FundPurchases {
                keeper: *signer,
                config: breaks_config(),
                break_,
                escrow: escrow_pda(&break_),
                buyer_usdc,
                treasury_authority: treasury_authority(),
                treasury_config: treasury_config(),
                subsidy_vault: subsidy_vault(),
                holder_vault: holder_vault(),
                treasury_program: treasury::ID,
                token_program: litesvm_token::TOKEN_ID,
            },
            breaks::instruction::FundPurchases {},
        )
    }

    fn fund(&mut self, id: u64) -> Sent {
        let keeper = self.keeper.insecure_clone();
        let i = self.fund_ix(&keeper.pubkey(), id, self.buyer_usdc);
        send(&mut self.svm, &keeper, &[], &[i])
    }

    fn commit_pool_as(&mut self, who: &Keypair, id: u64, size: u16) -> Sent {
        let i = ix(
            breaks::ID,
            self.keeper_call(&who.pubkey(), id),
            breaks::instruction::CommitPool {
                pool_hash: [3; 32],
                pool_size: size,
            },
        );
        send(&mut self.svm, who, &[], &[i])
    }

    fn cancel_as(&mut self, who: &Keypair, id: u64) -> Sent {
        let i = ix(
            breaks::ID,
            breaks::accounts::CancelBreak {
                admin: who.pubkey(),
                config: breaks_config(),
                break_: break_pda(id),
                treasury_authority: treasury_authority(),
                treasury_config: treasury_config(),
                subsidy_vault: subsidy_vault(),
                holder_vault: holder_vault(),
                treasury_program: treasury::ID,
            },
            breaks::instruction::CancelBreak {},
        );
        send(&mut self.svm, who, &[], &[i])
    }

    fn cancel(&mut self, id: u64) -> Sent {
        let admin = self.admin.insecure_clone();
        self.cancel_as(&admin, id)
    }

    fn refund(&mut self, payer: &Keypair, id: u64, index: u16, to: Address) -> Sent {
        let break_ = break_pda(id);
        let i = ix(
            breaks::ID,
            breaks::accounts::RefundSpot {
                break_,
                escrow: escrow_pda(&break_),
                spot: spot_pda(&break_, index),
                owner_usdc: to,
                token_program: litesvm_token::TOKEN_ID,
            },
            breaks::instruction::RefundSpot {},
        );
        send(&mut self.svm, payer, &[], &[i])
    }

    fn admin_call(&mut self, who: &Keypair, data: impl InstructionData) -> Sent {
        let i = ix(
            breaks::ID,
            breaks::accounts::AdminOnly {
                admin: who.pubkey(),
                config: breaks_config(),
            },
            data,
        );
        send(&mut self.svm, who, &[], &[i])
    }

    fn set_paused(&mut self, paused: bool) {
        let admin = self.admin.insecure_clone();
        self.admin_call(&admin, breaks::instruction::SetPaused { paused })
            .unwrap();
    }

    // ---- randomness

    fn request_id_for(&self, id: u64, attempt: u8) -> [u8; 32] {
        let b = self.brk(id);
        derive_request_id(&break_pda(id), attempt, &b.eligibility_root, &b.pool_hash)
    }

    /// Where the (mock) ORAO program keeps the request for `request_id`.
    fn request_for(&self, request_id: &[u8; 32]) -> Address {
        request_address(&mock_orao::ID, request_id)
    }

    fn request_randomness_ix(&self, who: &Address, id: u64, attempt: u8, previous: Address) -> Instruction {
        let request = self.request_for(&self.request_id_for(id, attempt));
        ix(
            breaks::ID,
            breaks::accounts::RequestRandomness {
                keeper: *who,
                config: breaks_config(),
                break_: break_pda(id),
                vrf_program: mock_orao::ID,
                vrf_network_state: vrf_network_state(),
                vrf_treasury: vrf_treasury(),
                request,
                previous_request: previous,
                system_program: anchor_lang::system_program::ID,
            },
            breaks::instruction::RequestRandomness {},
        )
    }

    /// The keeper asks for the first randomness of a committed break.
    fn request_randomness(&mut self, id: u64) -> Sent {
        let keeper = self.keeper.insecure_clone();
        let i = self.request_randomness_ix(&keeper.pubkey(), id, 0, anchor_lang::system_program::ID);
        send(&mut self.svm, &keeper, &[], &[i])
    }

    /// The keeper repeats the request of a break that is already waiting for an answer.
    fn repeat_randomness(&mut self, id: u64) -> Sent {
        let keeper = self.keeper.insecure_clone();
        let b = self.brk(id);
        let previous = self.request_for(&b.randomness_request_id);
        let i = self.request_randomness_ix(&keeper.pubkey(), id, b.randomness_attempt + 1, previous);
        send(&mut self.svm, &keeper, &[], &[i])
    }

    /// Anyone (here: a stranger) asks the VRF program for the seed before the keeper does.
    fn squat_request(&mut self, seed: [u8; 32]) -> Sent {
        let (stranger, _) = self.user(0);
        let i = ix(
            mock_orao::ID,
            mock_orao::accounts::RequestV2 {
                payer: stranger.pubkey(),
                network_state: vrf_network_state(),
                treasury: vrf_treasury(),
                request: self.request_for(&seed),
                system_program: anchor_lang::system_program::ID,
            },
            mock_orao::instruction::RequestV2 { seed },
        );
        send(&mut self.svm, &stranger, &[], &[i])
    }

    /// Test double for ORAO's oracles: sets the "random" answer of a request.
    fn mock_fulfill(&mut self, seed: [u8; 32], randomness: [u8; 64]) -> Sent {
        let i = ix(
            mock_orao::ID,
            mock_orao::accounts::FulfillForTest {
                request: self.request_for(&seed),
            },
            mock_orao::instruction::FulfillForTest { seed, randomness },
        );
        let authority = self.authority.insecure_clone();
        send(&mut self.svm, &authority, &[], &[i])
    }

    fn settle_with(&mut self, who: &Keypair, id: u64, request: Address) -> Sent {
        let i = ix(
            breaks::ID,
            breaks::accounts::SettleRandomness {
                config: breaks_config(),
                break_: break_pda(id),
                request,
            },
            breaks::instruction::SettleRandomness {},
        );
        send(&mut self.svm, who, &[], &[i])
    }

    /// Anyone settles the current request of a break.
    fn settle(&mut self, id: u64) -> Sent {
        let (stranger, _) = self.user(0);
        let request = self.request_for(&self.brk(id).randomness_request_id);
        self.settle_with(&stranger, id, request)
    }

    fn after_deadline(&mut self) {
        set_unix_time(&mut self.svm, T0 + 6 * HOUR);
    }

    /// Every USDC base unit in the system: users, buyer wallet, treasury vaults, escrows.
    fn total_usdc(&self, users: &[Address], break_ids: &[u64]) -> u64 {
        let mut accounts = vec![self.buyer_usdc, subsidy_vault(), holder_vault()];
        accounts.extend_from_slice(users);
        accounts.extend(break_ids.iter().map(|id| escrow_pda(&break_pda(*id))));
        accounts.iter().map(|a| self.balance(a)).sum()
    }
}

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
    assert_eq!(
        (b.paid_spots, b.free_spots, b.spot_price, b.max_pack_price),
        (10, 2, 20 * USDC, 25 * USDC)
    );
    assert_eq!((b.pack_machine, b.opens_at, b.closes_at), ([7; 32], T0, T0 + 6 * HOUR));
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
                max_pack_price: 0,
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
            BreaksError::SpotPriceAboveMaxPackPrice,
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
    let too_much_subsidy = CreateBreakParams {
        paid_spots: 20,
        spot_price: 10 * USDC,
        max_pack_price: 50 * USDC,
        free_spots: 0,
        ..params()
    };
    assert_fails_with(
        env.create_break_with(too_much_subsidy),
        treasury_code(TreasuryError::InsufficientAvailable),
    );
    // Holder: 6 free packs of $60 = $360 > $300 available.
    let too_much_holder = CreateBreakParams {
        free_spots: 6,
        max_pack_price: 60 * USDC,
        spot_price: 60 * USDC,
        ..params()
    };
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
    let big = CreateBreakParams {
        paid_spots: 20,
        free_spots: 0,
        spot_price: 10 * USDC,
        ..params()
    };
    env.create_break_with(big.clone()).unwrap();
    env.create_break_with(big.clone()).unwrap();
    assert_eq!(env.locked(), (600 * USDC, 0));
    // Only $100 of subsidy is left, not enough for a third.
    assert_fails_with(
        env.create_break_with(big),
        treasury_code(TreasuryError::InsufficientAvailable),
    );
    // A smaller one still fits: 5 spots x $15 = $75.
    env.create_break_with(CreateBreakParams {
        paid_spots: 5,
        free_spots: 0,
        spot_price: 10 * USDC,
        ..params()
    })
    .unwrap();
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
    env.create_break_with(CreateBreakParams {
        paid_spots: 2,
        ..params()
    })
    .unwrap();
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

/// A closed break with `sold` spots bought and eligibility committed (`eligible` holders).
fn closed_with(env: &mut Env, sold: u16, eligible: u32) -> (u64, Vec<(Keypair, Address)>) {
    let id = env.create_break();
    let buyers: Vec<_> = (0..sold).map(|_| env.sell_one(id)).collect();
    env.after_deadline();
    let (anyone, _) = env.user(0);
    env.close(&anyone, id).unwrap();
    env.commit_eligibility(id, if eligible == 0 { 0 } else { 1_000 }, eligible)
        .unwrap();
    (id, buyers)
}

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

/// A break that is funded and has its pool committed, so randomness can be requested.
fn committed(env: &mut Env) -> u64 {
    let (id, _) = closed_with(env, 3, 5);
    env.fund(id).unwrap();
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, id, 5).unwrap();
    id
}

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
fn the_seed_is_locked_in_by_anyone_once_the_adapter_answers_and_never_changes() {
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
    assert_eq!((env.brk(a).seed, env.brk(b).seed), ([1; 32], [2; 32]));
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
