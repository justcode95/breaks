//! Shared harness of the breaks on-chain tests: both programs and a VRF program run inside
//! LiteSVM. The VRF program is either `mock-orao` (the default) or the real ORAO program loaded
//! from a dump (see `orao`).

#![allow(dead_code)]

pub mod orao;

use anchor_lang::{solana_program::instruction::Instruction, AnchorDeserialize, InstructionData, ToAccountMetas};
use breaks::{
    errors::BreaksError,
    randomness::{request_address, request_id as derive_request_id},
    state::{Break, BreaksConfig, PackTier},
    CreateBreakParams,
};
use draw_core::Leaf;
use litesvm::LiteSVM;
use litesvm_token::{
    get_spl_account, spl_token::state::Account as TokenAccountState, CreateAssociatedTokenAccount, CreateMint, MintTo,
};
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;
use testkit::*;
use treasury::errors::TreasuryError;

pub const T0: i64 = 1_800_000_000;
pub const HOUR: i64 = 3600;

pub struct Env {
    pub svm: LiteSVM,
    /// Upgrade authority of both programs.
    pub authority: Keypair,
    pub treasury_admin: Keypair,
    pub admin: Keypair,
    pub keeper: Keypair,
    /// The pack buyer wallet and its USDC account.
    pub buyer: Keypair,
    pub buyer_usdc: Address,
    pub mint: Address,
    pub breaks_programdata: Address,
    pub vrf: Vrf,
}

pub fn code(e: BreaksError) -> u32 {
    ERROR_CODE_OFFSET + e as u32
}

pub fn treasury_code(e: TreasuryError) -> u32 {
    ERROR_CODE_OFFSET + e as u32
}

pub fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}

pub fn breaks_config() -> Address {
    pda(&[breaks::CONFIG_SEED], &breaks::ID)
}
pub fn treasury_authority() -> Address {
    pda(&[breaks::TREASURY_AUTHORITY_SEED], &breaks::ID)
}
pub fn break_pda(id: u64) -> Address {
    pda(&[breaks::BREAK_SEED, &id.to_le_bytes()], &breaks::ID)
}
pub fn escrow_pda(break_: &Address) -> Address {
    pda(&[breaks::ESCROW_SEED, break_.as_ref()], &breaks::ID)
}
pub fn spot_pda(break_: &Address, index: u16) -> Address {
    pda(&[breaks::SPOT_SEED, break_.as_ref(), &index.to_le_bytes()], &breaks::ID)
}
pub fn treasury_config() -> Address {
    pda(&[treasury::CONFIG_SEED], &treasury::ID)
}
pub fn subsidy_vault() -> Address {
    pda(&[treasury::SUBSIDY_VAULT_SEED], &treasury::ID)
}
pub fn holder_vault() -> Address {
    pda(&[treasury::HOLDER_VAULT_SEED], &treasury::ID)
}

/// Where `breaks` asks for randomness.
#[derive(Clone, Copy)]
pub struct Vrf {
    pub program: Address,
    pub network_state: Address,
    pub treasury: Address,
}

impl Vrf {
    /// `mock-orao`, which ignores the network state and the treasury: stand-in addresses.
    pub fn mock() -> Self {
        Vrf {
            program: mock_orao::ID,
            network_state: Address::new_from_array([0xA1; 32]),
            treasury: Address::new_from_array([0xA2; 32]),
        }
    }

    /// The real ORAO program, with its own network state and the treasury that names.
    pub fn real(orao: &orao::RealOrao) -> Self {
        Vrf {
            program: orao::id(),
            network_state: orao::network_state_address(),
            treasury: orao.treasury,
        }
    }
}

pub fn ix(program_id: Address, accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

/// A pack tier of machine `machine` whose packs cost at most `dollars`.
pub fn tier(machine: u8, dollars: u64) -> PackTier {
    PackTier {
        machine: [machine; 32],
        max_price: dollars * USDC,
    }
}

/// 10 paid spots at $20 for $25 packs (all from one machine) plus 2 free spots, open for 6 hours from `T0`.
pub fn params() -> CreateBreakParams {
    CreateBreakParams {
        paid_spots: 10,
        free_spots: 2,
        spot_price: 20 * USDC,
        tiers: vec![tier(7, 25)],
        packs: vec![0; 12],
        opens_at: T0,
        closes_at: T0 + 6 * HOUR,
    }
}

/// A mixed break: 6 paid spots at $20 and 2 free ones, with packs of $10 (four), $25 (two) and $50 (two), cheapest first.
/// $190 of packs over 8 spots is $23.75 each on average.
pub fn mixed() -> CreateBreakParams {
    CreateBreakParams {
        paid_spots: 6,
        free_spots: 2,
        spot_price: 20 * USDC,
        tiers: vec![tier(1, 10), tier(2, 25), tier(3, 50)],
        packs: vec![0, 0, 0, 0, 1, 1, 2, 2],
        ..params()
    }
}

/// The default break with another number of spots, every pack still one tier of `pack_dollars`.
pub fn uniform(paid_spots: u16, free_spots: u16, spot_dollars: u64, pack_dollars: u64) -> CreateBreakParams {
    CreateBreakParams {
        paid_spots,
        free_spots,
        spot_price: spot_dollars * USDC,
        tiers: vec![tier(7, pack_dollars)],
        packs: vec![0; usize::from(paid_spots) + usize::from(free_spots)],
        ..params()
    }
}

impl Env {
    /// Both programs deployed, treasury initialized with the breaks program as controller and
    /// funded with 1000 USDC (700 subsidy / 300 holder). Breaks itself is not initialized yet.
    /// Randomness comes from `mock-orao`.
    pub fn base() -> Self {
        Self::base_with(None)
    }

    /// Like `base()`, with the real ORAO program as the VRF when `orao` is given.
    pub fn base_with(orao: Option<&orao::RealOrao>) -> Self {
        let mut svm = LiteSVM::new();
        let [authority, treasury_admin, admin, keeper, buyer] = std::array::from_fn(|_| Keypair::new());
        for k in [&authority, &treasury_admin, &admin, &keeper, &buyer] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        set_unix_time(&mut svm, T0);

        let treasury_programdata = deploy(&mut svm, treasury::ID, "treasury", &authority.pubkey());
        let breaks_programdata = deploy(&mut svm, breaks::ID, "breaks", &authority.pubkey());
        let vrf = match orao {
            None => {
                deploy(&mut svm, mock_orao::ID, "mock_orao", &authority.pubkey());
                Vrf::mock()
            }
            Some(orao) => {
                orao.install(&mut svm);
                Vrf::real(orao)
            }
        };
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
            vrf,
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

    pub fn initialize_ix(&self, signer: &Address, program_data: Address) -> Instruction {
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
                    randomness_program: self.vrf.program,
                    randomness_timeout_secs: HOUR,
                },
            },
        )
    }

    /// `base()` plus an initialized breaks program.
    pub fn ready() -> Self {
        Self::ready_with(None)
    }

    /// `base_with(orao)` plus an initialized breaks program.
    pub fn ready_with(orao: Option<&orao::RealOrao>) -> Self {
        let mut env = Self::base_with(orao);
        let init = env.initialize_ix(&env.authority.pubkey(), env.breaks_programdata);
        env.send_as_authority(&[init]).unwrap();
        env
    }

    pub fn send_as_authority(&mut self, ixs: &[Instruction]) -> Sent {
        let authority = self.authority.insecure_clone();
        send(&mut self.svm, &authority, &[], ixs)
    }

    /// A funded wallet with a USDC account holding `amount`.
    pub fn user(&mut self, amount: u64) -> (Keypair, Address) {
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

    pub fn balance(&self, account: &Address) -> u64 {
        get_spl_account::<TokenAccountState>(&self.svm, account).unwrap().amount
    }

    pub fn read<T: AnchorDeserialize>(&self, address: &Address) -> T {
        let data = self
            .svm
            .get_account(address)
            .unwrap_or_else(|| panic!("no account {address}"))
            .data;
        T::deserialize(&mut &data[8..]).unwrap()
    }

    pub fn config(&self) -> BreaksConfig {
        self.read(&breaks_config())
    }
    pub fn brk(&self, id: u64) -> Break {
        self.read(&break_pda(id))
    }
    pub fn locked(&self) -> (u64, u64) {
        let c: treasury::state::Config = self.read(&treasury_config());
        (c.locked_subsidy, c.locked_holder)
    }

    pub fn create_break_ix(&self, signer: &Address, p: CreateBreakParams) -> Instruction {
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

    pub fn create_break_with(&mut self, p: CreateBreakParams) -> Sent {
        let keeper = self.keeper.insecure_clone();
        let i = self.create_break_ix(&keeper.pubkey(), p);
        send(&mut self.svm, &keeper, &[], &[i])
    }

    /// Creates the default break and returns its id.
    pub fn create_break(&mut self) -> u64 {
        let id = self.config().next_break_id;
        self.create_break_with(params()).unwrap();
        id
    }

    pub fn buy_spot(&mut self, who: &Keypair, who_usdc: Address, id: u64, index: u16) -> Sent {
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
    pub fn sell_one(&mut self, id: u64) -> (Keypair, Address) {
        let (who, ata) = self.user(20 * USDC);
        let index = self.brk(id).spots_sold;
        self.buy_spot(&who, ata, id, index).unwrap();
        (who, ata)
    }

    pub fn close(&mut self, who: &Keypair, id: u64) -> Sent {
        let i = ix(
            breaks::ID,
            breaks::accounts::CloseBreak { break_: break_pda(id) },
            breaks::instruction::CloseBreak {},
        );
        send(&mut self.svm, who, &[], &[i])
    }

    pub fn keeper_call(&self, signer: &Address, id: u64) -> breaks::accounts::KeeperBreakCall {
        breaks::accounts::KeeperBreakCall {
            keeper: *signer,
            config: breaks_config(),
            break_: break_pda(id),
        }
    }

    pub fn commit_eligibility_as(&mut self, who: &Keypair, id: u64, weight: u64, count: u32) -> Sent {
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

    pub fn commit_eligibility(&mut self, id: u64, weight: u64, count: u32) -> Sent {
        let keeper = self.keeper.insecure_clone();
        self.commit_eligibility_as(&keeper, id, weight, count)
    }

    pub fn fund_ix(&self, signer: &Address, id: u64, buyer_usdc: Address) -> Instruction {
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

    pub fn fund(&mut self, id: u64) -> Sent {
        let keeper = self.keeper.insecure_clone();
        let i = self.fund_ix(&keeper.pubkey(), id, self.buyer_usdc);
        send(&mut self.svm, &keeper, &[], &[i])
    }

    pub fn commit_pool_as(&mut self, who: &Keypair, id: u64, size: u16) -> Sent {
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

    pub fn cancel_as(&mut self, who: &Keypair, id: u64) -> Sent {
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

    pub fn cancel(&mut self, id: u64) -> Sent {
        let admin = self.admin.insecure_clone();
        self.cancel_as(&admin, id)
    }

    /// Anyone can send this: `who` only pays the fee, no account of the instruction signs.
    pub fn cancel_unfundable_as(&mut self, who: &Keypair, id: u64) -> Sent {
        let i = ix(
            breaks::ID,
            breaks::accounts::CancelUnfundable {
                break_: break_pda(id),
                treasury_authority: treasury_authority(),
                treasury_config: treasury_config(),
                subsidy_vault: subsidy_vault(),
                holder_vault: holder_vault(),
                treasury_program: treasury::ID,
            },
            breaks::instruction::CancelUnfundable {},
        );
        send(&mut self.svm, who, &[], &[i])
    }

    pub fn refund(&mut self, payer: &Keypair, id: u64, index: u16, to: Address) -> Sent {
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

    pub fn admin_call(&mut self, who: &Keypair, data: impl InstructionData) -> Sent {
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

    pub fn set_paused(&mut self, paused: bool) {
        let admin = self.admin.insecure_clone();
        self.admin_call(&admin, breaks::instruction::SetPaused { paused })
            .unwrap();
    }

    // ---- randomness

    pub fn request_id_for(&self, id: u64, attempt: u8) -> [u8; 32] {
        let b = self.brk(id);
        derive_request_id(&break_pda(id), attempt, &b.eligibility_root, &b.pool_hash)
    }

    /// Where the VRF program keeps the request for `request_id`.
    pub fn request_for(&self, request_id: &[u8; 32]) -> Address {
        request_address(&self.vrf.program, request_id)
    }

    pub fn request_randomness_ix(&self, who: &Address, id: u64, attempt: u8, previous: Address) -> Instruction {
        let request = self.request_for(&self.request_id_for(id, attempt));
        ix(
            breaks::ID,
            breaks::accounts::RequestRandomness {
                keeper: *who,
                config: breaks_config(),
                break_: break_pda(id),
                vrf_program: self.vrf.program,
                vrf_network_state: self.vrf.network_state,
                vrf_treasury: self.vrf.treasury,
                request,
                previous_request: previous,
                system_program: anchor_lang::system_program::ID,
            },
            breaks::instruction::RequestRandomness {},
        )
    }

    /// The keeper asks for the first randomness of a committed break.
    pub fn request_randomness(&mut self, id: u64) -> Sent {
        let keeper = self.keeper.insecure_clone();
        let i = self.request_randomness_ix(&keeper.pubkey(), id, 0, anchor_lang::system_program::ID);
        send(&mut self.svm, &keeper, &[], &[i])
    }

    /// The keeper repeats the request of a break that is already waiting for an answer.
    pub fn repeat_randomness(&mut self, id: u64) -> Sent {
        let keeper = self.keeper.insecure_clone();
        let b = self.brk(id);
        let previous = self.request_for(&b.randomness_request_id);
        let i = self.request_randomness_ix(&keeper.pubkey(), id, b.randomness_attempt + 1, previous);
        send(&mut self.svm, &keeper, &[], &[i])
    }

    /// Anyone (here: a stranger) asks `mock-orao` for the seed before the keeper does.
    pub fn squat_request(&mut self, seed: [u8; 32]) -> Sent {
        let (stranger, _) = self.user(0);
        let i = ix(
            mock_orao::ID,
            mock_orao::accounts::RequestV2 {
                payer: stranger.pubkey(),
                network_state: self.vrf.network_state,
                treasury: self.vrf.treasury,
                request: self.request_for(&seed),
                system_program: anchor_lang::system_program::ID,
            },
            mock_orao::instruction::RequestV2 { seed },
        );
        send(&mut self.svm, &stranger, &[], &[i])
    }

    /// Test double for ORAO's oracles (`mock-orao` only): sets the "random" answer of a request.
    pub fn mock_fulfill(&mut self, seed: [u8; 32], randomness: [u8; 64]) -> Sent {
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

    pub fn settle_with(&mut self, who: &Keypair, id: u64, request: Address) -> Sent {
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
    pub fn settle(&mut self, id: u64) -> Sent {
        let (stranger, _) = self.user(0);
        let request = self.request_for(&self.brk(id).randomness_request_id);
        self.settle_with(&stranger, id, request)
    }

    // ---- the draw

    pub fn commit_eligibility_with(&mut self, id: u64, root: [u8; 32], total_weight: u64, count: u32) -> Sent {
        let keeper = self.keeper.insecure_clone();
        let i = ix(
            breaks::ID,
            self.keeper_call(&keeper.pubkey(), id),
            breaks::instruction::CommitEligibility {
                root,
                total_weight,
                entry_count: count,
                inputs_hash: [2; 32],
            },
        );
        send(&mut self.svm, &keeper, &[], &[i])
    }

    pub fn claim_ix(
        &self,
        payer: &Address,
        id: u64,
        index: u8,
        wallet: Address,
        weight: u64,
        proof: &[draw_core::ProofStep],
    ) -> Instruction {
        ix(
            breaks::ID,
            breaks::accounts::ClaimFreeSpot {
                payer: *payer,
                break_: break_pda(id),
            },
            breaks::instruction::ClaimFreeSpot {
                index,
                wallet,
                weight,
                proof: proof
                    .iter()
                    .map(|s| breaks::ProofStepArg {
                        hash: s.sibling.hash,
                        sum: s.sibling.sum,
                        sibling_is_left: s.sibling_is_left,
                    })
                    .collect(),
            },
        )
    }

    /// Anyone (a stranger here) submits a free-spot winner.
    pub fn claim(&mut self, id: u64, index: u8, leaf: &Leaf, proof: &[draw_core::ProofStep]) -> Sent {
        let (stranger, _) = self.user(0);
        let i = self.claim_ix(
            &stranger.pubkey(),
            id,
            index,
            Address::new_from_array(leaf.wallet),
            leaf.weight,
            proof,
        );
        send(&mut self.svm, &stranger, &[], &[i])
    }

    pub fn after_deadline(&mut self) {
        set_unix_time(&mut self.svm, T0 + 6 * HOUR);
    }

    /// Every USDC base unit in the system: users, buyer wallet, treasury vaults, escrows.
    pub fn total_usdc(&self, users: &[Address], break_ids: &[u64]) -> u64 {
        let mut accounts = vec![self.buyer_usdc, subsidy_vault(), holder_vault()];
        accounts.extend_from_slice(users);
        accounts.extend(break_ids.iter().map(|id| escrow_pda(&break_pda(*id))));
        accounts.iter().map(|a| self.balance(a)).sum()
    }
}

/// A closed break with `sold` spots bought and eligibility committed (`eligible` holders).
pub fn closed_with(env: &mut Env, sold: u16, eligible: u32) -> (u64, Vec<(Keypair, Address)>) {
    let id = env.create_break();
    let buyers: Vec<_> = (0..sold).map(|_| env.sell_one(id)).collect();
    env.after_deadline();
    let (anyone, _) = env.user(0);
    env.close(&anyone, id).unwrap();
    env.commit_eligibility(id, if eligible == 0 { 0 } else { 1_000 }, eligible)
        .unwrap();
    (id, buyers)
}

/// A closed `mixed()` break with `sold` spots bought and eligibility committed (`eligible` holders).
pub fn mixed_closed(env: &mut Env, sold: u16, eligible: u32) -> (u64, Vec<(Keypair, Address)>) {
    let id = env.config().next_break_id;
    env.create_break_with(mixed()).unwrap();
    let buyers: Vec<_> = (0..sold).map(|_| env.sell_one(id)).collect();
    env.after_deadline();
    let (anyone, _) = env.user(0);
    env.close(&anyone, id).unwrap();
    env.commit_eligibility(id, if eligible == 0 { 0 } else { 1_000 }, eligible)
        .unwrap();
    (id, buyers)
}

/// A break that is funded and has its pool committed, so randomness can be requested.
pub fn committed(env: &mut Env) -> u64 {
    let (id, _) = closed_with(env, 3, 5);
    env.fund(id).unwrap();
    let keeper = env.keeper.insecure_clone();
    env.commit_pool_as(&keeper, id, 5).unwrap();
    id
}

/// Eligible wallets with the given weights, sorted by address like the tree needs.
pub fn eligible(weights: &[u64]) -> Vec<Leaf> {
    let mut wallets: Vec<Address> = weights.iter().map(|_| Address::new_unique()).collect();
    wallets.sort();
    wallets
        .iter()
        .zip(weights)
        .map(|(w, weight)| Leaf {
            wallet: w.to_bytes(),
            weight: *weight,
        })
        .collect()
}
