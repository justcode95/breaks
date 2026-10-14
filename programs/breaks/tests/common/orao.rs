//! The REAL ORAO VRF program inside LiteSVM, instead of `mock-orao`.
//!
//! The program and its network state are dumped from devnet by `scripts/dump-orao.sh` (CI does
//! this; set `ORAO_DUMP_DIR` to use another folder). ORAO's real oracles cannot be asked for an
//! answer, so the dumped network state is edited: its list of fulfilment authorities is replaced
//! by one test key. Everything else (the program, the fee, the treasury, the account layouts, the
//! checks on a request and on an answer) is ORAO's own. The oracle's answer is a real Ed25519
//! signature, checked by the Ed25519 precompile before ORAO's program looks at it.
//!
//! What this cannot show: how ORAO's real oracles behave, or that its upgrade authority stays put.

use std::path::PathBuf;

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use breaks::randomness::{request_address, REQUEST_V2_DISCRIMINATOR};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

pub const ORAO_ID: &str = "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y";
/// `sha256("global:fulfill_v2")[..8]`
pub const FULFILL_V2_DISCRIMINATOR: [u8; 8] = [0xa4, 0xe3, 0xed, 0x54, 0x70, 0x6f, 0x93, 0xc4];
/// What ORAO allocates for a request (8 + 1 + 32 + 32 + 4 + 7 * 96).
pub const REQUEST_ACCOUNT_SIZE: usize = 749;

pub fn id() -> Address {
    ORAO_ID.parse().unwrap()
}

pub fn network_state_address() -> Address {
    Address::find_program_address(&[b"orao-vrf-network-configuration"], &id()).0
}

pub fn ed25519_program() -> Address {
    "Ed25519SigVerify111111111111111111111111111".parse().unwrap()
}

pub fn instructions_sysvar() -> Address {
    "Sysvar1nstructions1111111111111111111111111".parse().unwrap()
}

/// ORAO's `NetworkState` account, byte for byte (checked against the real crate in `real_orao.rs`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkState {
    pub discriminator: [u8; 8],
    pub authority: [u8; 32],
    pub treasury: [u8; 32],
    pub request_fee: u64,
    pub oracles: Vec<[u8; 32]>,
    /// mint, treasury and fee (u64) of the optional fee in ORAO tokens.
    pub token_fee: Option<[u8; 72]>,
    pub num_received: u64,
}

impl NetworkState {
    /// Reads the account data; whatever follows the struct is padding (ORAO allocates 8 + 464).
    pub fn parse(data: &[u8]) -> Result<Self, String> {
        let mut at = 0usize;
        let mut take = |n: usize| -> Result<&[u8], String> {
            let out = data.get(at..at + n).ok_or_else(|| {
                format!(
                    "network state ends early (wanted {n} bytes at {at}, have {})",
                    data.len()
                )
            })?;
            at += n;
            Ok(out)
        };
        let discriminator: [u8; 8] = take(8)?.try_into().unwrap();
        let authority: [u8; 32] = take(32)?.try_into().unwrap();
        let treasury: [u8; 32] = take(32)?.try_into().unwrap();
        let request_fee = u64::from_le_bytes(take(8)?.try_into().unwrap());
        let count = u32::from_le_bytes(take(4)?.try_into().unwrap()) as usize;
        if count > 10 {
            return Err(format!("{count} oracles; ORAO allows at most 10"));
        }
        let mut oracles = Vec::new();
        for _ in 0..count {
            oracles.push(take(32)?.try_into().unwrap());
        }
        let token_fee = match take(1)?[0] {
            0 => None,
            1 => Some(take(72)?.try_into().unwrap()),
            tag => return Err(format!("unknown option tag {tag}")),
        };
        let num_received = u64::from_le_bytes(take(8)?.try_into().unwrap());
        Ok(NetworkState {
            discriminator,
            authority,
            treasury,
            request_fee,
            oracles,
            token_fee,
            num_received,
        })
    }

    /// The account data, zero-padded to `len` (the size of the account).
    pub fn to_bytes(&self, len: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(len);
        out.extend_from_slice(&self.discriminator);
        out.extend_from_slice(&self.authority);
        out.extend_from_slice(&self.treasury);
        out.extend_from_slice(&self.request_fee.to_le_bytes());
        out.extend_from_slice(&(self.oracles.len() as u32).to_le_bytes());
        for oracle in &self.oracles {
            out.extend_from_slice(oracle);
        }
        match &self.token_fee {
            None => out.push(0),
            Some(fee) => {
                out.push(1);
                out.extend_from_slice(fee);
            }
        }
        out.extend_from_slice(&self.num_received.to_le_bytes());
        assert!(out.len() <= len, "the network state does not fit in {len} bytes");
        out.resize(len, 0);
        out
    }
}

/// An Ed25519 precompile instruction with the signature and key inside it (the layout of Solana's
/// `new_ed25519_instruction`): ORAO reads the key, signature and message from here.
pub fn ed25519_instruction_with(public_key: &[u8; 32], signature: &[u8; 64], message: &[u8]) -> Instruction {
    let (public_key_offset, signature_offset, message_offset) = (16u16, 48u16, 112u16);
    let mut data = vec![1u8, 0];
    for field in [
        signature_offset,
        u16::MAX,
        public_key_offset,
        u16::MAX,
        message_offset,
        message.len() as u16,
        u16::MAX,
    ] {
        data.extend_from_slice(&field.to_le_bytes());
    }
    data.extend_from_slice(public_key);
    data.extend_from_slice(signature);
    data.extend_from_slice(message);
    Instruction {
        program_id: ed25519_program(),
        accounts: vec![],
        data,
    }
}

/// The signature `signer` makes of `message`, as 64 bytes.
pub fn sign(signer: &Keypair, message: &[u8]) -> [u8; 64] {
    signer.sign_message(message).as_ref().try_into().unwrap()
}

/// ORAO's `fulfill_v2`: the answer to the request at `request`, whose client is `client`.
pub fn fulfill_v2_instruction(payer: &Address, request: &Address, client: &Address) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(instructions_sysvar(), false),
            AccountMeta::new(network_state_address(), false),
            AccountMeta::new(*request, false),
            AccountMeta::new(*client, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        data: FULFILL_V2_DISCRIMINATOR.to_vec(),
    }
}

/// ORAO's `request_v2`, sent by `payer` themselves (as anyone can do for any seed).
pub fn request_v2_instruction(payer: &Address, treasury: &Address, seed: [u8; 32]) -> Instruction {
    let mut data = REQUEST_V2_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&seed);
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(network_state_address(), false),
            AccountMeta::new(*treasury, false),
            AccountMeta::new(request_address(&id(), &seed), false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        data,
    }
}

/// ORAO's program and network state as dumped from devnet, with the oracles replaced by one test key.
pub struct RealOrao {
    program: Vec<u8>,
    state: NetworkState,
    state_len: usize,
    /// The key that stands in for ORAO's oracles. Its signature of a seed is the answer.
    pub oracle: Keypair,
    pub treasury: Address,
    pub request_fee: u64,
}

impl RealOrao {
    pub fn dump_dir() -> PathBuf {
        std::env::var_os("ORAO_DUMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../orao-dump"))
    }

    /// Loads the dump. Fails on purpose when it is missing, like the other on-chain tests do when
    /// their program is not built.
    pub fn load() -> Self {
        let dir = Self::dump_dir();
        let read = |name: &str| {
            let path = dir.join(name);
            std::fs::read(&path).unwrap_or_else(|e| {
                panic!(
                    "cannot read {}: {e}. Dump ORAO from devnet first with `scripts/dump-orao.sh` \
                     (or set ORAO_DUMP_DIR).",
                    path.display()
                )
            })
        };
        let program = read("orao_vrf.so");
        let raw_state = read("network_state.bin");
        assert!(program.starts_with(b"\x7fELF"), "orao_vrf.so is not an ELF program");
        let mut state = NetworkState::parse(&raw_state).unwrap_or_else(|e| panic!("network_state.bin: {e}"));
        let oracle = Keypair::new();
        state.oracles = vec![oracle.pubkey().to_bytes()];
        RealOrao {
            program,
            treasury: Address::new_from_array(state.treasury),
            request_fee: state.request_fee,
            state_len: raw_state.len(),
            state,
            oracle,
        }
    }

    /// Puts ORAO and its (edited) network state into `svm`, and makes sure its treasury exists.
    pub fn install(&self, svm: &mut LiteSVM) {
        svm.add_program(id(), &self.program).unwrap();
        svm.set_account(
            network_state_address(),
            Account {
                lamports: 10_000_000_000,
                data: self.state.to_bytes(self.state_len),
                owner: id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        if svm.get_account(&self.treasury).is_none() {
            svm.set_account(
                self.treasury,
                Account {
                    lamports: 1_000_000_000,
                    data: vec![],
                    owner: anchor_lang::system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        }
    }
}
