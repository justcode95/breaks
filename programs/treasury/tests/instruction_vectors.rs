//! Writes (and checks) the exact bytes and account lists of every treasury instruction as JSON,
//! for the TypeScript keeper's tests. Does not need the SBF build.

use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use solana_address::Address;
use testkit::*;
use treasury::{
    accounts, instruction,
    state::{Bucket, Config},
    InitializeParams,
};

fn pda(seed: &[u8]) -> Address {
    Address::find_program_address(&[seed], &treasury::ID).0
}

fn programdata() -> Address {
    let loader: Address = UPGRADEABLE_LOADER.parse().unwrap();
    Address::find_program_address(&[treasury::ID.as_ref()], &loader).0
}

#[test]
fn treasury_instruction_vectors() {
    let (config, subsidy, holder) = (
        pda(treasury::CONFIG_SEED),
        pda(treasury::SUBSIDY_VAULT_SEED),
        pda(treasury::HOLDER_VAULT_SEED),
    );
    let token = litesvm_token::TOKEN_ID;
    let system = anchor_lang::system_program::ID;

    let authority = pk(1);
    let admin = pk(2);
    let mint = pk(3);
    let depositor = pk(4);
    let depositor_usdc = pk(5);
    let controller = pk(6);
    let destination = pk(7);

    let initialize = instruction_case(
        "treasury.initialize",
        &format!("{{ \"authority\": \"{authority}\", \"usdcMint\": \"{mint}\", \"admin\": \"{admin}\", \"subsidyBps\": 7000, \"holderBps\": 3000 }}"),
        &instruction::Initialize { params: InitializeParams { admin, subsidy_bps: 7_000, holder_bps: 3_000 } }.data(),
        &accounts::Initialize {
            authority,
            program: treasury::ID,
            program_data: programdata(),
            config,
            usdc_mint: mint,
            subsidy_vault: subsidy,
            holder_vault: holder,
            token_program: token,
            system_program: system,
        }
        .to_account_metas(None),
    );
    let deposit = instruction_case(
        "treasury.deposit_fees",
        &format!(
            "{{ \"depositor\": \"{depositor}\", \"depositorUsdc\": \"{depositor_usdc}\", \"amount\": \"123456789\" }}"
        ),
        &instruction::DepositFees { amount: 123_456_789 }.data(),
        &accounts::DepositFees {
            depositor,
            depositor_usdc,
            config,
            subsidy_vault: subsidy,
            holder_vault: holder,
            token_program: token,
        }
        .to_account_metas(None),
    );
    let set_split = instruction_case(
        "treasury.set_split",
        &format!("{{ \"admin\": \"{admin}\", \"subsidyBps\": 5000, \"holderBps\": 5000 }}"),
        &instruction::SetSplit {
            subsidy_bps: 5_000,
            holder_bps: 5_000,
        }
        .data(),
        &accounts::SetSplit { admin, config }.to_account_metas(None),
    );
    let set_controller = instruction_case(
        "treasury.set_controller",
        &format!("{{ \"admin\": \"{admin}\", \"controller\": \"{controller}\" }}"),
        &instruction::SetController { controller }.data(),
        &accounts::SetController { admin, config }.to_account_metas(None),
    );
    let controller_call = |name: &str, data: Vec<u8>| {
        instruction_case(
            name,
            &format!("{{ \"controller\": \"{controller}\", \"subsidy\": \"1000000\", \"holder\": \"2500000\" }}"),
            &data,
            &accounts::ControllerCall {
                controller,
                config,
                subsidy_vault: subsidy,
                holder_vault: holder,
            }
            .to_account_metas(None),
        )
    };
    let lock = controller_call(
        "treasury.lock_funds",
        instruction::LockFunds {
            subsidy: 1_000_000,
            holder: 2_500_000,
        }
        .data(),
    );
    let unlock = controller_call(
        "treasury.unlock_funds",
        instruction::UnlockFunds {
            subsidy: 1_000_000,
            holder: 2_500_000,
        }
        .data(),
    );
    let pay = |bucket: Bucket, label: &str| {
        instruction_case(
            "treasury.pay_from_locked",
            &format!("{{ \"controller\": \"{controller}\", \"destination\": \"{destination}\", \"bucket\": \"{label}\", \"amount\": \"42\" }}"),
            &instruction::PayFromLocked { bucket, amount: 42 }.data(),
            &accounts::PayFromLocked {
                controller,
                config,
                subsidy_vault: subsidy,
                holder_vault: holder,
                destination,
                token_program: token,
            }
            .to_account_metas(None),
        )
    };

    let sample = Config {
        admin,
        usdc_mint: mint,
        controller,
        subsidy_bps: 7_000,
        holder_bps: 3_000,
        locked_subsidy: 111,
        locked_holder: 222,
        bump: 253,
    };
    let mut bytes = Vec::new();
    sample.try_serialize(&mut bytes).unwrap();
    let config_account = value_case(
        "treasury.account.Config",
        &format!("{{ \"data\": \"{}\" }}", hex(&bytes)),
        &format!(
            "{{ \"admin\": \"{admin}\", \"usdcMint\": \"{mint}\", \"controller\": \"{controller}\", \"subsidyBps\": 7000, \"holderBps\": 3000, \"lockedSubsidy\": \"111\", \"lockedHolder\": \"222\", \"bump\": 253 }}"
        ),
    );

    // An SPL token account as the token program writes it: the keeper reads the vaults' balances from these.
    let vault = {
        use anchor_spl::token::spl_token::state::{Account, AccountState};
        use solana_program_pack::Pack;
        let account = Account {
            mint,
            owner: controller,
            amount: 123_456_789_012,
            delegate: None.into(),
            state: AccountState::Initialized,
            is_native: None.into(),
            delegated_amount: 0,
            close_authority: None.into(),
        };
        let mut bytes = vec![0u8; Account::LEN];
        Account::pack(account, &mut bytes).unwrap();
        value_case(
            "spl.account.TokenAccount",
            &format!("{{ \"data\": \"{}\" }}", hex(&bytes)),
            &format!("{{ \"mint\": \"{mint}\", \"owner\": \"{controller}\", \"amount\": \"123456789012\" }}"),
        )
    };

    // An SPL token mint as the token program writes it: the keeper checks TOKEN_MINT with it and the website reads the
    // coin's decimals from it. Both authorities are set, so a field read at the wrong offset shows.
    let token_mint = {
        use anchor_spl::token::spl_token::state::Mint;
        use solana_program_pack::Pack;
        let m = Mint {
            mint_authority: Some(admin).into(),
            supply: 987_654_321_000_000_000,
            decimals: 9,
            is_initialized: true,
            freeze_authority: Some(controller).into(),
        };
        let mut bytes = vec![0u8; Mint::LEN];
        Mint::pack(m, &mut bytes).unwrap();
        value_case(
            "spl.account.Mint",
            &format!("{{ \"data\": \"{}\" }}", hex(&bytes)),
            "{ \"supply\": \"987654321000000000\", \"decimals\": 9, \"initialized\": true }",
        )
    };

    check_vectors(
        concat!(env!("CARGO_MANIFEST_DIR"), "/instruction-vectors.json"),
        &format!("{{ \"treasury\": \"{}\" }}", treasury::ID),
        &[
            initialize,
            deposit,
            set_split,
            set_controller,
            lock,
            unlock,
            pay(Bucket::Subsidy, "Subsidy"),
            pay(Bucket::Holder, "Holder"),
            config_account,
            vault,
            token_mint,
        ],
    );
}
