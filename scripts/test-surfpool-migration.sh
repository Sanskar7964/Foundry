#!/usr/bin/env bash
set -euo pipefail

# Run this in a SECOND WSL terminal after Surfpool is running on port 8899.
# Surfpool deploys the local target/deploy binaries, while its Devnet fork
# supplies Raydium CPMM and its AMM configuration. No Devnet SOL is used.
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
# AnchorProvider.env() requires this even though Surfpool gives this wallet
# local airdrop funds. Respect an explicitly supplied test-wallet path.
export ANCHOR_WALLET="${ANCHOR_WALLET:-${HOME}/.config/solana/id.json}"
export SURFPOOL_MIGRATION_TEST=true

if [[ ! -f "$ANCHOR_WALLET" ]]; then
  echo "ANCHOR_WALLET does not exist: $ANCHOR_WALLET" >&2
  exit 1
fi

anchor build

# Do not call `anchor test`: it would run the legacy ts-mocha command from
# Anchor.toml. Recent Node versions load that command as ESM while Anchor's
# JavaScript client is CommonJS. Compile tests to CommonJS first instead.
./node_modules/.bin/tsc --project tsconfig.surfpool.json
# The Devnet fork already contains the global Merkle keeper PDA, so the
# unrelated airdrop suite cannot initialize its local-only fixture. Restrict
# this command to the bonding-curve cases, including the Surfpool migration
# assertion; reward and Merkle coverage remains in the normal local suite.
./node_modules/.bin/mocha -t 1000000 --grep 'reward-vault|merkle-distributor|does not let the creator transfer tokens out of the airdrop reserve' --invert '.surfpool-tests/tests/**/*.js'
