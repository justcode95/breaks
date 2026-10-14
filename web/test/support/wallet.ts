// A pretend wallet that follows the Wallet Standard, typed with the standard's own feature types: if the standard's shapes change,
// this file stops compiling. It remembers how it was called and can announce account changes.

import {
  SolanaSignAndSendTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignAndSendTransactionInput,
  type SolanaSignAndSendTransactionOutput,
} from "@solana/wallet-standard-features";
import type { Wallet, WalletAccount, WalletIcon } from "@wallet-standard/base";
import {
  StandardConnect,
  type StandardConnectFeature,
  StandardDisconnect,
  type StandardDisconnectFeature,
  StandardEvents,
  type StandardEventsFeature,
  type StandardEventsListeners,
} from "@wallet-standard/features";
import { type Address, addressFromBytes } from "../../lib/chain/address";

export const fill = (n: number): Address => addressFromBytes(new Uint8Array(32).fill(n));

/** A devnet-capable account whose address and key agree, unless told otherwise. */
export function pretendAccount(n: number, over: Partial<Pick<WalletAccount, "chains" | "features">> & { publicKey?: Uint8Array } = {}): WalletAccount {
  return {
    address: fill(n),
    publicKey: over.publicKey ?? new Uint8Array(32).fill(n),
    chains: over.chains ?? ["solana:devnet", "solana:mainnet"],
    features: over.features ?? [SolanaSignAndSendTransaction],
  };
}

export const PNG: WalletIcon = "data:image/png;base64,iVBORw0KGgo=";

export interface PretendOptions {
  name?: string;
  chains?: Wallet["chains"];
  /** Which optional features the wallet has (connect and sending are on unless a list leaves them out). */
  only?: ("connect" | "disconnect" | "events" | "send")[];
  accounts?: WalletAccount[];
  connect?: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }>;
  disconnect?: () => Promise<void>;
  /** What the wallet does when asked to sign and send: by default it "sends" and answers with a signature of 64 sevens. */
  send?: (...inputs: readonly SolanaSignAndSendTransactionInput[]) => Promise<readonly SolanaSignAndSendTransactionOutput[]>;
}

export interface Pretend extends Wallet {
  connectCalls: ({ silent?: boolean } | undefined)[];
  disconnectCalls: number;
  /** Every request to sign and send, as the wallet received it. */
  sendCalls: SolanaSignAndSendTransactionInput[];
  listeners: number;
  /** Announces a change of accounts to everyone listening. */
  emit: (accounts: readonly WalletAccount[]) => void;
}

export function pretendWallet(opts: PretendOptions = {}): Pretend {
  const has = (f: NonNullable<PretendOptions["only"]>[number]) => !opts.only || opts.only.includes(f);
  const listeners = new Set<StandardEventsListeners["change"]>();
  const accounts = opts.accounts ?? [pretendAccount(1)];
  const wallet: Pretend = {
    version: "1.0.0",
    name: opts.name ?? "Pretend Wallet",
    icon: PNG,
    chains: opts.chains ?? ["solana:devnet", "solana:mainnet"],
    accounts: [],
    features: {},
    connectCalls: [],
    disconnectCalls: 0,
    sendCalls: [],
    get listeners() {
      return listeners.size;
    },
    emit: (a) => {
      for (const l of [...listeners]) l({ accounts: a });
    },
  };
  const features = {
    ...(has("connect")
      ? {
          [StandardConnect]: {
            version: "1.0.0",
            connect: async (input?: { silent?: boolean }) => {
              wallet.connectCalls.push(input);
              return opts.connect ? opts.connect(input) : { accounts };
            },
          } satisfies StandardConnectFeature[typeof StandardConnect],
        }
      : {}),
    ...(has("disconnect")
      ? {
          [StandardDisconnect]: {
            version: "1.0.0",
            disconnect: async () => {
              wallet.disconnectCalls++;
              if (opts.disconnect) await opts.disconnect();
            },
          } satisfies StandardDisconnectFeature[typeof StandardDisconnect],
        }
      : {}),
    ...(has("events")
      ? {
          [StandardEvents]: {
            version: "1.0.0",
            on: (event, listener) => {
              if (event !== "change") return () => {};
              const change = listener as StandardEventsListeners["change"];
              listeners.add(change);
              return () => void listeners.delete(change);
            },
          } satisfies StandardEventsFeature[typeof StandardEvents],
        }
      : {}),
    ...(has("send")
      ? {
          [SolanaSignAndSendTransaction]: {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            signAndSendTransaction: async (...inputs) => {
              wallet.sendCalls.push(...inputs);
              return opts.send ? opts.send(...inputs) : [{ signature: new Uint8Array(64).fill(7) }];
            },
          } satisfies SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction],
        }
      : {}),
  };
  Object.assign(wallet, { features });
  return wallet;
}
