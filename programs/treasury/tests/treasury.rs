//! On-chain tests for the treasury program (see `testkit` for the shared helpers).
//!
//! Needs the SBF build first: `cargo build-sbf --manifest-path programs/treasury/Cargo.toml`
//! (CI does this). Point `TREASURY_SO` at a different file to test another build.

use anchor_lang::{solana_program::instruction::Instruction, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use litesvm_token::{
    get_spl_account, spl_token::state::Account as TokenAccountState, CreateAssociatedTokenAccount, CreateMint, MintTo,
};
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;
use testkit::*;
use treasury::{
    errors::TreasuryError,
    state::{Bucket, Config},
    ControllerChanged, FeesDeposited, FundsLocked, FundsPaid, FundsUnlocked, InitializeParams, SplitChanged,
};

struct Env {
    svm: LiteSVM,
    /// Upgrade authority of the program (the Squads multisig in production).
    authority: Keypair,
    /// Signs `set_split` and `set_controller` (also a multisig vault in production).
    admin: Keypair,
    /// Stands in for the `breaks` program's treasury-authority PDA.
    controller: Keypair,
    mint: Address,
    config: Address,
    subsidy_vault: Address,
    holder_vault: Address,
    programdata: Address,
}

fn program_id() -> Address {
    treasury::ID
}

fn pda(seed: &[u8]) -> Address {
    Address::find_program_address(&[seed], &program_id()).0
}

fn custom_code(e: TreasuryError) -> u32 {
    ERROR_CODE_OFFSET + e as u32
}

impl Env {
    /// Program deployed (upgrade authority = `authority`), a USDC-like mint created, nothing initialized yet.
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let authority = Keypair::new();
        let admin = Keypair::new();
        let controller = Keypair::new();
        for k in [&authority, &admin, &controller] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        let programdata = deploy(&mut svm, program_id(), "treasury", &authority.pubkey());
        let mint = CreateMint::new(&mut svm, &authority).decimals(6).send().unwrap();
        Env {
            svm,
            authority,
            admin,
            controller,
            mint,
            config: pda(treasury::CONFIG_SEED),
            subsidy_vault: pda(treasury::SUBSIDY_VAULT_SEED),
            holder_vault: pda(treasury::HOLDER_VAULT_SEED),
            programdata,
        }
    }

    fn initialize_ix(&self, signer: &Address, program_data: Address, subsidy_bps: u16, holder_bps: u16) -> Instruction {
        Instruction {
            program_id: program_id(),
            accounts: treasury::accounts::Initialize {
                authority: *signer,
                program: program_id(),
                program_data,
                config: self.config,
                usdc_mint: self.mint,
                subsidy_vault: self.subsidy_vault,
                holder_vault: self.holder_vault,
                token_program: litesvm_token::TOKEN_ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: treasury::instruction::Initialize {
                params: InitializeParams {
                    admin: self.admin.pubkey(),
                    subsidy_bps,
                    holder_bps,
                },
            }
            .data(),
        }
    }

    fn initialize(&mut self, subsidy_bps: u16, holder_bps: u16) -> Sent {
        let ix = self.initialize_ix(&self.authority.pubkey(), self.programdata, subsidy_bps, holder_bps);
        let authority = self.authority.insecure_clone();
        send(&mut self.svm, &authority, &[], &[ix])
    }

    /// A funded wallet with a USDC token account holding `amount` base units.
    fn depositor(&mut self, amount: u64) -> (Keypair, Address) {
        let wallet = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), 1_000_000_000).unwrap();
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

    fn deposit_ix(&self, depositor: &Address, source: Address, subsidy_vault: Address, amount: u64) -> Instruction {
        Instruction {
            program_id: program_id(),
            accounts: treasury::accounts::DepositFees {
                depositor: *depositor,
                depositor_usdc: source,
                config: self.config,
                subsidy_vault,
                holder_vault: self.holder_vault,
                token_program: litesvm_token::TOKEN_ID,
            }
            .to_account_metas(None),
            data: treasury::instruction::DepositFees { amount }.data(),
        }
    }

    fn deposit(&mut self, wallet: &Keypair, source: Address, amount: u64) -> Sent {
        let ix = self.deposit_ix(&wallet.pubkey(), source, self.subsidy_vault, amount);
        send(&mut self.svm, wallet, &[], &[ix])
    }

    fn set_split_as(&mut self, signer: &Keypair, subsidy_bps: u16, holder_bps: u16) -> Sent {
        let ix = Instruction {
            program_id: program_id(),
            accounts: treasury::accounts::SetSplit {
                admin: signer.pubkey(),
                config: self.config,
            }
            .to_account_metas(None),
            data: treasury::instruction::SetSplit {
                subsidy_bps,
                holder_bps,
            }
            .data(),
        };
        send(&mut self.svm, signer, &[], &[ix])
    }

    fn set_controller_as(&mut self, signer: &Keypair, controller: Address) -> Sent {
        let ix = Instruction {
            program_id: program_id(),
            accounts: treasury::accounts::SetController {
                admin: signer.pubkey(),
                config: self.config,
            }
            .to_account_metas(None),
            data: treasury::instruction::SetController { controller }.data(),
        };
        send(&mut self.svm, signer, &[], &[ix])
    }

    fn lock_as(&mut self, signer: &Keypair, subsidy: u64, holder: u64) -> Sent {
        let ix = self.controller_ix(
            &signer.pubkey(),
            treasury::instruction::LockFunds { subsidy, holder }.data(),
        );
        send(&mut self.svm, signer, &[], &[ix])
    }

    fn unlock_as(&mut self, signer: &Keypair, subsidy: u64, holder: u64) -> Sent {
        let ix = self.controller_ix(
            &signer.pubkey(),
            treasury::instruction::UnlockFunds { subsidy, holder }.data(),
        );
        send(&mut self.svm, signer, &[], &[ix])
    }

    fn controller_ix(&self, controller: &Address, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: program_id(),
            accounts: treasury::accounts::ControllerCall {
                controller: *controller,
                config: self.config,
                subsidy_vault: self.subsidy_vault,
                holder_vault: self.holder_vault,
            }
            .to_account_metas(None),
            data,
        }
    }

    fn pay_as(&mut self, signer: &Keypair, bucket: Bucket, amount: u64, destination: Address) -> Sent {
        let ix = Instruction {
            program_id: program_id(),
            accounts: treasury::accounts::PayFromLocked {
                controller: signer.pubkey(),
                config: self.config,
                subsidy_vault: self.subsidy_vault,
                holder_vault: self.holder_vault,
                destination,
                token_program: litesvm_token::TOKEN_ID,
            }
            .to_account_metas(None),
            data: treasury::instruction::PayFromLocked { bucket, amount }.data(),
        };
        send(&mut self.svm, signer, &[], &[ix])
    }

    fn token_balance(&self, account: &Address) -> u64 {
        get_spl_account::<TokenAccountState>(&self.svm, account).unwrap().amount
    }

    fn config(&self) -> Config {
        let data = self.svm.get_account(&self.config).expect("config account").data;
        anchor_lang::AnchorDeserialize::deserialize(&mut &data[8..]).unwrap()
    }
}

fn initialized() -> Env {
    let mut env = Env::new();
    env.initialize(7_000, 3_000).unwrap();
    env
}

/// Initialized, controller appointed, and 100 USDC deposited (70 subsidy / 30 holder).
fn funded() -> Env {
    let mut env = initialized();
    let admin = env.admin.insecure_clone();
    env.set_controller_as(&admin, env.controller.pubkey()).unwrap();
    let (wallet, ata) = env.depositor(1_000 * USDC);
    env.deposit(&wallet, ata, 100 * USDC).unwrap();
    env
}

// ---------------------------------------------------------------- initialize

#[test]
fn initialize_stores_config_and_creates_both_vaults() {
    let mut env = Env::new();
    let meta = env.initialize(7_000, 3_000).unwrap();

    let config = env.config();
    assert_eq!(config.admin, env.admin.pubkey());
    assert_eq!(config.usdc_mint, env.mint);
    assert_eq!((config.subsidy_bps, config.holder_bps), (7_000, 3_000));

    for vault in [env.subsidy_vault, env.holder_vault] {
        let state = get_spl_account::<TokenAccountState>(&env.svm, &vault).unwrap();
        assert_eq!(state.mint, env.mint);
        assert_eq!(state.owner, env.config, "vault must be controlled by the config PDA");
        assert_eq!(state.amount, 0);
    }
    assert!(
        meta.logs.iter().any(|l| l.starts_with("Program data: ")),
        "Initialized event missing"
    );
}

#[test]
fn initialize_rejects_anyone_but_the_upgrade_authority() {
    let mut env = Env::new();
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();
    let ix = env.initialize_ix(&attacker.pubkey(), env.programdata, 7_000, 3_000);
    assert_fails_with(
        send(&mut env.svm, &attacker, &[], &[ix]),
        custom_code(TreasuryError::Unauthorized),
    );
    assert!(
        env.svm.get_account(&env.config).is_none(),
        "config must not exist after a rejected init"
    );
}

#[test]
fn initialize_rejects_a_forged_program_data_account() {
    let mut env = Env::new();
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();

    // The attacker makes a look-alike ProgramData account that names them as upgrade authority.
    let forged = Address::new_unique();
    let loader: Address = UPGRADEABLE_LOADER.parse().unwrap();
    let mut account = env.svm.get_account(&env.programdata).unwrap();
    account.owner = loader;
    account.data[..45].copy_from_slice(&programdata_metadata(0, Some(&attacker.pubkey())));
    env.svm.set_account(forged, account).unwrap();

    let ix = env.initialize_ix(&attacker.pubkey(), forged, 7_000, 3_000);
    assert_fails_with(
        send(&mut env.svm, &attacker, &[], &[ix]),
        custom_code(TreasuryError::InvalidProgramData),
    );
    assert!(env.svm.get_account(&env.config).is_none());
}

#[test]
fn initialize_rejects_a_split_that_does_not_add_up() {
    let mut env = Env::new();
    assert_fails_with(env.initialize(7_000, 2_999), custom_code(TreasuryError::InvalidSplit));
    assert_fails_with(env.initialize(7_000, 3_001), custom_code(TreasuryError::InvalidSplit));
    assert!(env.svm.get_account(&env.config).is_none());
}

#[test]
fn initialize_cannot_run_twice() {
    let mut env = initialized();
    let before = env.config();
    assert!(env.initialize(5_000, 5_000).is_err());
    let after = env.config();
    assert_eq!(
        (after.subsidy_bps, after.holder_bps, after.admin),
        (before.subsidy_bps, before.holder_bps, before.admin)
    );
}

// ---------------------------------------------------------------- deposit_fees

#[test]
fn deposit_splits_70_30_and_emits_an_event() {
    let mut env = initialized();
    let (wallet, ata) = env.depositor(1_000 * USDC);
    let meta = env.deposit(&wallet, ata, 100 * USDC).unwrap();

    assert_eq!(env.token_balance(&env.subsidy_vault), 70 * USDC);
    assert_eq!(env.token_balance(&env.holder_vault), 30 * USDC);
    assert_eq!(env.token_balance(&ata), 900 * USDC);

    let event: FeesDeposited = find_event(&meta.logs).expect("FeesDeposited event");
    assert_eq!(event.depositor, wallet.pubkey());
    assert_eq!(
        (event.amount, event.to_subsidy, event.to_holder),
        (100 * USDC, 70 * USDC, 30 * USDC)
    );
}

#[test]
fn deposit_remainder_goes_to_the_holder_bucket() {
    let mut env = initialized();
    let (wallet, ata) = env.depositor(10);
    env.deposit(&wallet, ata, 1).unwrap();
    assert_eq!(
        (
            env.token_balance(&env.subsidy_vault),
            env.token_balance(&env.holder_vault)
        ),
        (0, 1)
    );
    env.deposit(&wallet, ata, 3).unwrap();
    assert_eq!(
        (
            env.token_balance(&env.subsidy_vault),
            env.token_balance(&env.holder_vault)
        ),
        (2, 2)
    );
}

#[test]
fn deposit_rejects_zero() {
    let mut env = initialized();
    let (wallet, ata) = env.depositor(5 * USDC);
    assert_fails_with(env.deposit(&wallet, ata, 0), custom_code(TreasuryError::ZeroAmount));
}

#[test]
fn deposit_cannot_exceed_the_depositors_balance() {
    let mut env = initialized();
    let (wallet, ata) = env.depositor(5 * USDC);
    assert!(env.deposit(&wallet, ata, 5 * USDC + 1).is_err());
    assert_eq!(env.token_balance(&ata), 5 * USDC);
    assert_eq!(
        (
            env.token_balance(&env.subsidy_vault),
            env.token_balance(&env.holder_vault)
        ),
        (0, 0)
    );
}

#[test]
fn deposit_rejects_a_source_account_of_another_mint() {
    let mut env = initialized();
    let authority = env.authority.insecure_clone();
    let other_mint = CreateMint::new(&mut env.svm, &authority).decimals(6).send().unwrap();
    let wallet = Keypair::new();
    env.svm.airdrop(&wallet.pubkey(), 1_000_000_000).unwrap();
    let ata = CreateAssociatedTokenAccount::new(&mut env.svm, &authority, &other_mint)
        .owner(&wallet.pubkey())
        .send()
        .unwrap();
    MintTo::new(&mut env.svm, &authority, &other_mint, &ata, 10 * USDC)
        .send()
        .unwrap();

    assert_fails_with(env.deposit(&wallet, ata, USDC), ErrorCode::ConstraintTokenMint as u32);
}

#[test]
fn deposit_rejects_a_source_account_the_signer_does_not_own() {
    let mut env = initialized();
    let (_victim, victim_ata) = env.depositor(10 * USDC);
    let (thief, _own_ata) = env.depositor(0);
    assert_fails_with(
        env.deposit(&thief, victim_ata, USDC),
        ErrorCode::ConstraintTokenOwner as u32,
    );
    assert_eq!(env.token_balance(&victim_ata), 10 * USDC);
}

#[test]
fn deposit_rejects_a_substituted_vault() {
    let mut env = initialized();
    let (wallet, ata) = env.depositor(10 * USDC);
    let (_other, attacker_ata) = env.depositor(0);
    let ix = env.deposit_ix(&wallet.pubkey(), ata, attacker_ata, USDC);
    assert_fails_with(
        send(&mut env.svm, &wallet, &[], &[ix]),
        ErrorCode::ConstraintSeeds as u32,
    );
    assert_eq!(env.token_balance(&attacker_ata), 0);
}

#[test]
fn deposit_fails_before_initialize() {
    let mut env = Env::new();
    let (wallet, ata) = env.depositor(10 * USDC);
    assert!(env.deposit(&wallet, ata, USDC).is_err());
}

// ---------------------------------------------------------------- set_split

#[test]
fn set_split_changes_how_later_deposits_are_divided() {
    let mut env = initialized();
    let (wallet, ata) = env.depositor(1_000 * USDC);
    env.deposit(&wallet, ata, 100 * USDC).unwrap();

    let admin = env.admin.insecure_clone();
    let meta = env.set_split_as(&admin, 5_000, 5_000).unwrap();
    let event: SplitChanged = find_event(&meta.logs).expect("SplitChanged event");
    assert_eq!(
        (
            event.old_subsidy_bps,
            event.old_holder_bps,
            event.subsidy_bps,
            event.holder_bps
        ),
        (7_000, 3_000, 5_000, 5_000)
    );

    // Balances already in the buckets do not move.
    assert_eq!(
        (
            env.token_balance(&env.subsidy_vault),
            env.token_balance(&env.holder_vault)
        ),
        (70 * USDC, 30 * USDC)
    );

    env.deposit(&wallet, ata, 100 * USDC).unwrap();
    assert_eq!(
        (
            env.token_balance(&env.subsidy_vault),
            env.token_balance(&env.holder_vault)
        ),
        (120 * USDC, 80 * USDC)
    );
}

#[test]
fn set_split_accepts_all_to_one_bucket() {
    let mut env = initialized();
    let admin = env.admin.insecure_clone();
    let (wallet, ata) = env.depositor(100 * USDC);

    env.set_split_as(&admin, 0, 10_000).unwrap();
    env.deposit(&wallet, ata, 10 * USDC).unwrap();
    assert_eq!(
        (
            env.token_balance(&env.subsidy_vault),
            env.token_balance(&env.holder_vault)
        ),
        (0, 10 * USDC)
    );

    env.set_split_as(&admin, 10_000, 0).unwrap();
    env.deposit(&wallet, ata, 10 * USDC).unwrap();
    assert_eq!(
        (
            env.token_balance(&env.subsidy_vault),
            env.token_balance(&env.holder_vault)
        ),
        (10 * USDC, 10 * USDC)
    );
}

#[test]
fn set_split_rejects_anyone_but_the_admin() {
    let mut env = initialized();
    let authority = env.authority.insecure_clone(); // upgrade authority is not the admin
    assert_fails_with(
        env.set_split_as(&authority, 1_000, 9_000),
        custom_code(TreasuryError::Unauthorized),
    );
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    assert_fails_with(
        env.set_split_as(&stranger, 1_000, 9_000),
        custom_code(TreasuryError::Unauthorized),
    );
    assert_eq!((env.config().subsidy_bps, env.config().holder_bps), (7_000, 3_000));
}

#[test]
fn set_split_rejects_a_split_that_does_not_add_up() {
    let mut env = initialized();
    let admin = env.admin.insecure_clone();
    assert_fails_with(
        env.set_split_as(&admin, 6_000, 3_000),
        custom_code(TreasuryError::InvalidSplit),
    );
    assert_fails_with(
        env.set_split_as(&admin, 10_001, 0),
        custom_code(TreasuryError::InvalidSplit),
    );
    assert_eq!((env.config().subsidy_bps, env.config().holder_bps), (7_000, 3_000));
}

// ---------------------------------------------------------------- invariants

#[test]
fn no_base_unit_is_ever_lost_across_many_deposits_and_split_changes() {
    let mut env = initialized();
    let admin = env.admin.insecure_clone();
    let start = 1_000_000_007u64;
    let (wallet, ata) = env.depositor(start);

    let mut deposited = 0u64;
    for (i, amount) in [1u64, 7, 99, 12_345, 1_000_003, 3, 999_999].into_iter().enumerate() {
        let (s, h) = [(7_000u16, 3_000u16), (3_333, 6_667), (1, 9_999), (9_999, 1)][i % 4];
        env.set_split_as(&admin, s, h).unwrap();
        env.deposit(&wallet, ata, amount).unwrap();
        deposited += amount;
        assert_eq!(
            env.token_balance(&env.subsidy_vault) + env.token_balance(&env.holder_vault),
            deposited
        );
        assert_eq!(env.token_balance(&ata), start - deposited);
    }
}

// ---------------------------------------------------------------- set_controller

#[test]
fn a_fresh_treasury_has_no_controller_and_nothing_locked() {
    let env = initialized();
    let config = env.config();
    assert_eq!(config.controller, Address::default());
    assert_eq!((config.locked_subsidy, config.locked_holder), (0, 0));
}

#[test]
fn set_controller_is_admin_only() {
    let mut env = initialized();
    let admin = env.admin.insecure_clone();
    let authority = env.authority.insecure_clone();
    let target = env.controller.pubkey();

    assert_fails_with(
        env.set_controller_as(&authority, target),
        custom_code(TreasuryError::Unauthorized),
    );
    assert_eq!(env.config().controller, Address::default());

    let meta = env.set_controller_as(&admin, target).unwrap();
    assert_eq!(env.config().controller, target);
    let event: ControllerChanged = find_event(&meta.logs).expect("ControllerChanged event");
    assert_eq!((event.old_controller, event.controller), (Address::default(), target));
}

// ---------------------------------------------------------------- lock_funds / unlock_funds

#[test]
fn lock_reserves_funds_in_each_bucket() {
    let mut env = funded();
    let controller = env.controller.insecure_clone();
    let meta = env.lock_as(&controller, 20 * USDC, 10 * USDC).unwrap();
    let config = env.config();
    assert_eq!((config.locked_subsidy, config.locked_holder), (20 * USDC, 10 * USDC));
    // Locking is bookkeeping; no token moves.
    assert_eq!(
        (
            env.token_balance(&env.subsidy_vault),
            env.token_balance(&env.holder_vault)
        ),
        (70 * USDC, 30 * USDC)
    );
    let event: FundsLocked = find_event(&meta.logs).expect("FundsLocked event");
    assert_eq!((event.subsidy, event.holder), (20 * USDC, 10 * USDC));
}

#[test]
fn lock_cannot_exceed_what_is_unlocked_in_either_bucket() {
    let mut env = funded();
    let controller = env.controller.insecure_clone();
    assert_fails_with(
        env.lock_as(&controller, 70 * USDC + 1, 0),
        custom_code(TreasuryError::InsufficientAvailable),
    );
    assert_fails_with(
        env.lock_as(&controller, 0, 30 * USDC + 1),
        custom_code(TreasuryError::InsufficientAvailable),
    );

    // Exactly everything is fine, and then nothing more is available.
    env.lock_as(&controller, 70 * USDC, 30 * USDC).unwrap();
    assert_fails_with(
        env.lock_as(&controller, 1, 0),
        custom_code(TreasuryError::InsufficientAvailable),
    );
    assert_fails_with(
        env.lock_as(&controller, 0, 1),
        custom_code(TreasuryError::InsufficientAvailable),
    );
    // A failed lock changes nothing.
    assert_eq!(
        (env.config().locked_subsidy, env.config().locked_holder),
        (70 * USDC, 30 * USDC)
    );
}

#[test]
fn new_deposits_make_more_funds_lockable() {
    let mut env = funded();
    let controller = env.controller.insecure_clone();
    env.lock_as(&controller, 70 * USDC, 30 * USDC).unwrap();
    let (wallet, ata) = env.depositor(10 * USDC);
    env.deposit(&wallet, ata, 10 * USDC).unwrap(); // +7 subsidy, +3 holder
    env.lock_as(&controller, 7 * USDC, 3 * USDC).unwrap();
}

#[test]
fn only_the_controller_can_lock_and_unlock() {
    let mut env = funded();
    let admin = env.admin.insecure_clone();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    for who in [&admin, &stranger] {
        assert_fails_with(env.lock_as(who, USDC, 0), custom_code(TreasuryError::Unauthorized));
        assert_fails_with(env.unlock_as(who, 0, 0), custom_code(TreasuryError::Unauthorized));
    }
}

#[test]
fn lock_fails_while_no_controller_is_set() {
    let mut env = initialized();
    let anyone = env.controller.insecure_clone();
    assert_fails_with(env.lock_as(&anyone, 0, 0), custom_code(TreasuryError::Unauthorized));
}

#[test]
fn unlock_frees_funds_again_but_never_more_than_was_locked() {
    let mut env = funded();
    let controller = env.controller.insecure_clone();
    env.lock_as(&controller, 50 * USDC, 20 * USDC).unwrap();

    assert_fails_with(
        env.unlock_as(&controller, 50 * USDC + 1, 0),
        custom_code(TreasuryError::InsufficientLocked),
    );
    assert_fails_with(
        env.unlock_as(&controller, 0, 20 * USDC + 1),
        custom_code(TreasuryError::InsufficientLocked),
    );

    let meta = env.unlock_as(&controller, 30 * USDC, 20 * USDC).unwrap();
    assert_eq!(
        (env.config().locked_subsidy, env.config().locked_holder),
        (20 * USDC, 0)
    );
    let event: FundsUnlocked = find_event(&meta.logs).expect("FundsUnlocked event");
    assert_eq!((event.locked_subsidy, event.locked_holder), (20 * USDC, 0));

    // The freed part can be locked again.
    env.lock_as(&controller, 50 * USDC, 30 * USDC).unwrap();
}

// ---------------------------------------------------------------- pay_from_locked

#[test]
fn pay_moves_locked_funds_to_the_destination_and_shrinks_the_lock() {
    let mut env = funded();
    let controller = env.controller.insecure_clone();
    let (_buyer, buyer_ata) = env.depositor(0);
    env.lock_as(&controller, 40 * USDC, 15 * USDC).unwrap();

    let meta = env.pay_as(&controller, Bucket::Subsidy, 25 * USDC, buyer_ata).unwrap();
    assert_eq!(env.token_balance(&buyer_ata), 25 * USDC);
    assert_eq!(env.token_balance(&env.subsidy_vault), 45 * USDC);
    assert_eq!(
        (env.config().locked_subsidy, env.config().locked_holder),
        (15 * USDC, 15 * USDC)
    );
    let event: FundsPaid = find_event(&meta.logs).expect("FundsPaid event");
    assert_eq!(
        (event.bucket, event.amount, event.destination),
        (Bucket::Subsidy, 25 * USDC, buyer_ata)
    );

    env.pay_as(&controller, Bucket::Holder, 15 * USDC, buyer_ata).unwrap();
    assert_eq!(env.token_balance(&buyer_ata), 40 * USDC);
    assert_eq!(env.token_balance(&env.holder_vault), 15 * USDC);
    assert_eq!(
        (env.config().locked_subsidy, env.config().locked_holder),
        (15 * USDC, 0)
    );
}

#[test]
fn pay_cannot_touch_funds_that_are_not_locked() {
    let mut env = funded();
    let controller = env.controller.insecure_clone();
    let (_buyer, buyer_ata) = env.depositor(0);
    env.lock_as(&controller, 10 * USDC, 0).unwrap();

    // Plenty of money in the vault, but only 10 is locked.
    assert_fails_with(
        env.pay_as(&controller, Bucket::Subsidy, 10 * USDC + 1, buyer_ata),
        custom_code(TreasuryError::InsufficientLocked),
    );
    assert_fails_with(
        env.pay_as(&controller, Bucket::Holder, 1, buyer_ata),
        custom_code(TreasuryError::InsufficientLocked),
    );
    assert_eq!(env.token_balance(&buyer_ata), 0);
    assert_eq!(env.token_balance(&env.subsidy_vault), 70 * USDC);
}

#[test]
fn only_the_controller_can_pay_out() {
    let mut env = funded();
    let controller = env.controller.insecure_clone();
    let admin = env.admin.insecure_clone();
    let (thief, thief_ata) = env.depositor(0);
    env.lock_as(&controller, 10 * USDC, 10 * USDC).unwrap();

    for who in [&admin, &thief] {
        assert_fails_with(
            env.pay_as(who, Bucket::Subsidy, USDC, thief_ata),
            custom_code(TreasuryError::Unauthorized),
        );
    }
    assert_eq!(env.token_balance(&thief_ata), 0);
}

#[test]
fn pay_rejects_a_destination_of_another_mint() {
    let mut env = funded();
    let controller = env.controller.insecure_clone();
    let authority = env.authority.insecure_clone();
    let other_mint = CreateMint::new(&mut env.svm, &authority).decimals(6).send().unwrap();
    let other_ata = CreateAssociatedTokenAccount::new(&mut env.svm, &authority, &other_mint)
        .send()
        .unwrap();
    env.lock_as(&controller, 10 * USDC, 0).unwrap();
    assert_fails_with(
        env.pay_as(&controller, Bucket::Subsidy, USDC, other_ata),
        ErrorCode::ConstraintTokenMint as u32,
    );
}

#[test]
fn locks_pay_outs_and_deposits_never_create_or_destroy_value() {
    let mut env = funded();
    let controller = env.controller.insecure_clone();
    let (_buyer, buyer_ata) = env.depositor(0);
    let total = |env: &Env| {
        env.token_balance(&env.subsidy_vault) + env.token_balance(&env.holder_vault) + env.token_balance(&buyer_ata)
    };

    assert_eq!(total(&env), 100 * USDC);
    env.lock_as(&controller, 30 * USDC, 12 * USDC).unwrap();
    env.pay_as(&controller, Bucket::Subsidy, 11 * USDC, buyer_ata).unwrap();
    env.pay_as(&controller, Bucket::Holder, 12 * USDC, buyer_ata).unwrap();
    env.unlock_as(&controller, 19 * USDC, 0).unwrap();
    assert_eq!(total(&env), 100 * USDC);
    assert_eq!((env.config().locked_subsidy, env.config().locked_holder), (0, 0));
    // What is left in the buckets is exactly what is lockable.
    env.lock_as(&controller, 70 * USDC - 11 * USDC, 30 * USDC - 12 * USDC)
        .unwrap();
}
