# Deploying to devnet

This is the concrete checklist for item 1 (deploy) followed by item 2 (point
the frontend at it). Run everything from the workspace root unless noted.

## 1. Install the toolchain (skip anything already installed)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.30.1 && avm use 0.30.1
```

## 2. Point the Solana CLI at devnet and fund your wallet

```bash
solana config set --url https://api.devnet.solana.com
solana-keygen new --outfile ~/.config/solana/id.json   # skip if you already have one
solana airdrop 2                                        # devnet SOL, free
```

## 3. Build — this generates your program's real addresses

```bash
npm install          # installs JS deps for the test suite
anchor build
anchor keys list
```

`anchor keys list` prints three addresses, one per program. Copy each into:
- `declare_id!("...")` at the top of the matching `programs/*/src/lib.rs`
- the `[programs.localnet]` section of `Anchor.toml`

Then rebuild so the binaries embed the correct IDs:

```bash
anchor build
```

## 4. Deploy

```bash
anchor deploy --provider.cluster devnet
```

This costs a small amount of devnet SOL per program (rent for the program
account) — the airdrop from step 2 covers it. If it runs out, `solana airdrop 2`
again.

## 5. Push the IDL on-chain (optional but recommended)

Lets any client fetch the IDL directly from the cluster instead of needing a
local copy:

```bash
anchor idl init --filepath target/idl/launchpad_core.json <LAUNCHPAD_CORE_PROGRAM_ID>
anchor idl init --filepath target/idl/reward_vault.json <REWARD_VAULT_PROGRAM_ID>
anchor idl init --filepath target/idl/merkle_distributor.json <MERKLE_DISTRIBUTOR_PROGRAM_ID>
```

## 6. Wire the frontend to your deployed programs

```bash
cp target/idl/launchpad_core.json frontend/lib/anchor/idl/launchpad_core.json
cp target/idl/reward_vault.json frontend/lib/anchor/idl/reward_vault.json
cp target/idl/merkle_distributor.json frontend/lib/anchor/idl/merkle_distributor.json

cd frontend
cp .env.example .env.local
```

Edit `.env.local` and paste in the three program IDs from `anchor keys list`,
plus your LAUNCHPAD governance-token mint once you've created it (see step 7).

Then remove the `as any` casts in `lib/anchor/program.ts`'s `.accounts(...)`
calls — they exist only because the placeholder IDL had no instructions for
TypeScript to type against; the real IDL fixes that and the casts become
unnecessary (safe to leave them too, they just widen the type).

## 7. Mint the LAUNCHPAD governance/fee-share token and init the staking pool

Devnet example with the Solana CLI's token helpers:

```bash
spl-token create-token --decimals 6          # prints the mint address — this is LAUNCHPAD_TOKEN_MINT
spl-token create-account <MINT>
spl-token mint <MINT> 1000000000             # 1B supply, adjust to taste
```

Then call `reward_vault::initialize_pool` once against that mint (via the
Anchor test harness, a small script, or `anchor run` — there's no UI for this
one-time step since it only happens once per deployment).

## 8. Run the frontend

```bash
npm install
npm run dev
```

Open http://localhost:3000, connect Phantom or Solflare (set to devnet in the
wallet's own settings), and the "Active launches" list, buy/sell, staking,
and claims pages will be live against your deployed programs instead of the
`lib/demo-data.ts` fixtures — swap the demo list for a real indexer read
(see `README.md`'s "Known gaps" section) when you're ready to go further.

## Sanity checklist before you call it "deployed"

- [ ] `anchor test` passes locally against your build
- [ ] `solana program show <PROGRAM_ID> --url devnet` shows each program as deployed
- [ ] a test wallet can create a launch, buy, sell, stake, claim, and receive
      a holder-airdrop claim — the full loop, on devnet, before mainnet
