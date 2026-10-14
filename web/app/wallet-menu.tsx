import type { Wallet } from "@wallet-standard/base";
import { money } from "../lib/chain/view";
import { type WalletState, displayName, safeIcon, shortAddress } from "../lib/wallet/wallets";

/** What the menu says about the wallet's USDC. `off` when the site is not set up to read the chain, so there is nothing to say. */
export type BalanceView = { kind: "off" } | { kind: "loading" } | { kind: "loaded"; balance: bigint | null } | { kind: "error"; message: string };

export interface WalletMenuProps {
  state: WalletState;
  balance: BalanceView;
  open: boolean;
  onToggle: () => void;
  onConnect: (wallet: Wallet) => void;
  onDisconnect: () => void;
  onRefresh: () => void;
}

function balanceText(b: BalanceView): string | undefined {
  switch (b.kind) {
    case "off":
      return undefined;
    case "loading":
      return "USDC balance: reading…";
    case "loaded":
      return b.balance === null ? "USDC balance: none, this wallet has no USDC account yet." : `USDC balance: ${money(b.balance)}`;
    case "error":
      return `Could not read the USDC balance: ${b.message}`;
  }
}

/** The wallet button in the header and the panel under it. Pure: the state comes in, the clicks go out. */
export function WalletMenu({ state, balance, open, onToggle, onConnect, onDisconnect, onRefresh }: WalletMenuProps) {
  const { connected, connecting } = state;
  const text = balanceText(balance);
  return (
    <div className="wallet">
      <button type="button" className={connected ? "wallet-pill secondary" : "wallet-connect"} aria-expanded={open} aria-controls="wallet-panel" onClick={onToggle}>
        {connected ? (
          <>
            <span className="dot" aria-hidden="true" />
            <span className="sr-only">Wallet connected: </span>
            {shortAddress(connected.account.address)}
          </>
        ) : state.status === "connecting" ? (
          "Connecting…"
        ) : (
          "Connect wallet"
        )}
      </button>
      {open && (
        <div id="wallet-panel" className="wallet-panel" role="group" aria-label="Wallet">
          {state.error && (
            <p className="problem" role="alert">
              {state.error}
            </p>
          )}
          {connected ? (
            <>
              <p className="hint">Connected with {displayName(connected.wallet)} on devnet.</p>
              <code className="mono wrap">{connected.account.address}</code>
              {text && <p className="balance">{text}</p>}
              <div className="actions">
                {balance.kind !== "off" && (
                  <button type="button" className="secondary" onClick={onRefresh}>
                    Refresh balance
                  </button>
                )}
                <button type="button" className="secondary" onClick={onDisconnect}>
                  Disconnect
                </button>
              </div>
            </>
          ) : state.status === "connecting" ? (
            <p>Waiting for {connecting}… approve the request in your wallet.</p>
          ) : state.usable.length > 0 ? (
            <>
              <p className="hint">Choose a wallet. This site only works on Solana devnet.</p>
              <ul className="wallet-list">
                {state.usable.map((w) => {
                  const icon = safeIcon(w.icon);
                  return (
                    <li key={w.name}>
                      <button type="button" className="secondary" onClick={() => onConnect(w)}>
                        {icon && <img src={icon} alt="" width={20} height={20} />}
                        {displayName(w)}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p>No wallet that works with Solana devnet was found in this browser. Use a Solana wallet extension that supports devnet, then reload this page.</p>
          )}
          {!connected && state.status !== "connecting" && state.skipped.length > 0 && (
            <p className="hint">
              Found, but not usable here: {state.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
