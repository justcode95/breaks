#!/usr/bin/env bash
# Dumps ORAO's VRF program and its network state from devnet, for the tests that run the breaks
# program against the real ORAO (programs/breaks/tests/real_orao.rs).
#
#   scripts/dump-orao.sh [output-dir]        (default: orao-dump)
#
# Needs the Solana CLI (for `solana program dump`), curl, jq and base64. The folder is written in
# one piece: a failed run leaves an earlier dump untouched. Set ORAO_RPC_URL to use another node.
set -euo pipefail

url="${ORAO_RPC_URL:-https://api.devnet.solana.com}"
out="${1:-orao-dump}"
program=VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y
# PDA ["orao-vrf-network-configuration"] of the program above.
state=5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK
# First 8 bytes of an Anchor `NetworkState` account: sha256("account:NetworkState")[..8].
state_discriminator=d4ed943861f533a9

work="$(mktemp -d "${out%/}.partial.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# The public node rate-limits now and then: try a few times with a growing pause.
retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then return 0; fi
    echo "attempt $attempt failed: $*" >&2
    sleep $((attempt * 3))
  done
  return 1
}

# Writes the raw data of an account to a file.
account_data() {
  local address="$1" file="$2" body
  body="$(curl -sS --fail --max-time 60 -X POST "$url" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$address\",{\"encoding\":\"base64\",\"commitment\":\"finalized\"}]}")" || return 1
  printf '%s' "$body" | jq -er '.result.value.data[0]' | base64 -d >"$file" || return 1
  [ -s "$file" ]
}

retry solana program dump "$program" "$work/orao_vrf.so" --url "$url"
retry account_data "$state" "$work/network_state.bin"

if [ "$(head -c 4 "$work/orao_vrf.so" | od -An -c | tr -d ' \n')" != '177ELF' ]; then
  echo "orao_vrf.so is not an ELF program" >&2
  exit 1
fi
if [ "$(head -c 8 "$work/network_state.bin" | od -An -tx1 | tr -d ' \n')" != "$state_discriminator" ]; then
  echo "network_state.bin does not start with the NetworkState discriminator" >&2
  exit 1
fi

rm -rf "$out"
mv "$work" "$out"
trap - EXIT
echo "dumped from $url into $out:"
(cd "$out" && wc -c orao_vrf.so network_state.bin && sha256sum orao_vrf.so network_state.bin)
