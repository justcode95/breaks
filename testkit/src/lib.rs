//! Helpers shared by the on-chain tests of every program. The compiled programs run inside
//! LiteSVM, so each case goes through real account validation, PDA checks and CPIs.
//!
//! The programs must be built first: `cargo build-sbf --manifest-path programs/<name>/Cargo.toml`
//! (CI does this). Set `<NAME>_SO` (e.g. `TREASURY_SO`) to test a different build.

use anchor_lang::{prelude::Clock, solana_program::instruction::Instruction, AnchorDeserialize, Discriminator};
use base64::Engine;
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_address::Address;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

pub use anchor_lang::error::{ErrorCode, ERROR_CODE_OFFSET};

pub const USDC: u64 = 1_000_000;
pub const UPGRADEABLE_LOADER: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

pub type Sent = Result<TransactionMetadata, FailedTransactionMetadata>;

/// Asserts the transaction failed with exactly this custom error code (Anchor error codes
/// start at `ERROR_CODE_OFFSET`; framework errors are in `ErrorCode`).
pub fn assert_fails_with(result: Sent, code: u32) {
    assert_fails_with_ctx(result, code, "")
}

/// Like [`assert_fails_with`], with a label that is shown when the assertion fails.
pub fn assert_fails_with_ctx(result: Sent, code: u32, ctx: &str) {
    match result {
        Ok(_) => panic!("{ctx}: expected error {code}, but the transaction succeeded"),
        Err(f) => match f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => {
                assert_eq!(c, code, "{ctx}: wrong error code; logs:\n{}", f.meta.logs.join("\n"))
            }
            other => panic!(
                "{ctx}: expected custom error {code}, got {other:?}; logs:\n{}",
                f.meta.logs.join("\n")
            ),
        },
    }
}

/// Signs with `payer` (fee payer) plus `extra`, using a fresh blockhash so identical
/// transactions are never rejected as duplicates.
pub fn send(svm: &mut LiteSVM, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction]) -> Sent {
    svm.expire_blockhash();
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new(
        &signers,
        Message::new(ixs, Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

/// Decodes the first Anchor event of type `T` found in the logs.
pub fn find_event<T: AnchorDeserialize + Discriminator>(logs: &[String]) -> Option<T> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .find_map(|b64| {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
            let body = bytes.strip_prefix(T::DISCRIMINATOR)?;
            T::deserialize(&mut &body[..]).ok()
        })
}

/// bincode layout of `UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address }`.
pub fn programdata_metadata(slot: u64, authority: Option<&Address>) -> Vec<u8> {
    let mut out = Vec::with_capacity(45);
    out.extend_from_slice(&3u32.to_le_bytes());
    out.extend_from_slice(&slot.to_le_bytes());
    match authority {
        Some(a) => {
            out.push(1);
            out.extend_from_slice(a.as_ref());
        }
        None => {
            out.push(0);
            out.extend_from_slice(&[0u8; 32]);
        }
    }
    out
}

pub fn upgradeable_loader() -> Address {
    UPGRADEABLE_LOADER.parse().unwrap()
}

/// Path of the compiled program: `<NAME>_SO` env var, else `target/deploy/<name>.so`.
pub fn so_path(name: &str) -> String {
    let var = format!("{}_SO", name.to_uppercase());
    std::env::var(var).unwrap_or_else(|_| format!("{}/../target/deploy/{name}.so", env!("CARGO_MANIFEST_DIR")))
}

/// Deploys the compiled program (upgradeable loader) with `authority` as its upgrade authority,
/// like a real deployment. Returns the ProgramData address.
pub fn deploy(svm: &mut LiteSVM, program_id: Address, name: &str, authority: &Address) -> Address {
    let path = so_path(name);
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read {path}: {e}. Build it first with `cargo build-sbf`."));
    // LiteSVM deploys with no upgrade authority; give the program one.
    svm.add_program(program_id, &bytes).unwrap();
    let programdata = Address::find_program_address(&[program_id.as_ref()], &upgradeable_loader()).0;
    let mut account = svm.get_account(&programdata).expect("programdata account");
    account.data[..45].copy_from_slice(&programdata_metadata(0, Some(authority)));
    svm.set_account(programdata, account).unwrap();
    programdata
}

pub fn set_unix_time(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

pub fn unix_time(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

// ---------------------------------------------------------------- vectors for other languages
//
// The Rust programs are the source of truth. These helpers write what they produce (instruction
// bytes, account lists, account data) as JSON so the TypeScript keeper can be tested against it.

pub use anchor_lang::solana_program::instruction::AccountMeta;

/// A recognizable address: 32 copies of `n`.
pub fn pk(n: u8) -> Address {
    Address::new_from_array([n; 32])
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// One instruction example: the high-level `inputs` (a JSON object as text), the data bytes and
/// the ordered account list with flags.
pub fn instruction_case(name: &str, inputs: &str, data: &[u8], metas: &[AccountMeta]) -> String {
    let accounts: Vec<String> = metas
        .iter()
        .map(|m| {
            format!(
                "{{ \"pubkey\": \"{}\", \"signer\": {}, \"writable\": {} }}",
                m.pubkey, m.is_signer, m.is_writable
            )
        })
        .collect();
    format!(
        "    {{\n      \"name\": \"{name}\",\n      \"inputs\": {inputs},\n      \"data\": \"{}\",\n      \"accounts\": [\n        {}\n      ]\n    }}",
        hex(data),
        accounts.join(",\n        ")
    )
}

/// A plain example of something other than an instruction (an id derivation, account bytes).
pub fn value_case(name: &str, inputs: &str, outputs: &str) -> String {
    format!("    {{\n      \"name\": \"{name}\",\n      \"inputs\": {inputs},\n      \"outputs\": {outputs}\n    }}")
}

/// Compares `cases` with the committed file at `path`, or rewrites it when `UPDATE_VECTORS` is set.
pub fn check_vectors(path: &str, programs: &str, cases: &[String]) {
    let generated = format!(
        "{{\n  \"comment\": \"Generated by the Rust tests (UPDATE_VECTORS=1 cargo test to regenerate). The TypeScript keeper must reproduce every value. 64-bit numbers are strings.\",\n  \"programs\": {programs},\n  \"cases\": [\n{}\n  ]\n}}\n",
        cases.join(",\n")
    );
    if std::env::var("UPDATE_VECTORS").is_ok() {
        std::fs::write(path, &generated).unwrap();
    }
    let committed =
        std::fs::read_to_string(path).unwrap_or_else(|_| panic!("{path} is missing; run with UPDATE_VECTORS=1"));
    assert_eq!(
        committed, generated,
        "{path} is out of date (UPDATE_VECTORS=1 to regenerate)"
    );
}
