# Fast Mainnet Deployment Checklist

This is the shortest responsible path from the working Devnet version to a
mainnet launch. It does **not** require another 85 SOL Devnet test.

Already proven; do not repeat:

- core create/buy/sell/stake/claim/unstake Devnet tests;
- holder airdrop claim flow;
- 85 SOL Devnet Raydium migration and post-migration site buy/sell;
- local Surfpool test: the Railway-style keeper detects a ready curve and
  migrates it automatically through Raydium.

## Part 1: Free preparation

1. Stop changing program code. Push the current working commit to GitHub.

2. Keep a release record. In a terminal, run and save the output:

   ```bash
   cd /mnt/c/dev
   git rev-parse HEAD
   solana --version
   anchor --version
   rustc --version
   ```

3. Decide these three things on paper:

   - the three mainnet multisig members;
   - the dedicated mainnet keeper wallet (it pays only transaction fees and
     possible WSOL-ATA rent, never the curve's 85 SOL liquidity);
   - a mainnet RPC URL and where the frontend will be hosted.

4. Do **not** copy Devnet program keypairs or the Devnet Squads Vault to
   mainnet. Mainnet needs new program IDs and a new mainnet Squads Vault.

## Part 2: Deployment-day actions (real SOL begins here)

1. Create and fund the new mainnet 2-of-3 Squads multisig. Record its **Vault
   PDA**. The Vault PDA, not the Multisig PDA, will become program upgrade
   authority.

2. Create new, separately backed-up mainnet program keypairs. Never overwrite
   `target/deploy/*-keypair.json`, because those are your Devnet deployment
   identities. Use a new release branch/folder and update these together:

   - `declare_id!` in all three Rust programs;
   - `[programs.mainnet]` in `Anchor.toml`;
   - copied frontend IDLs;
   - production frontend `NEXT_PUBLIC_*_PROGRAM_ID` values.

3. Before deploying, verify Raydium's current **mainnet** CPMM program, AMM
   config, and create-pool-fee addresses from Raydium's official docs. Set the
   mainnet values in `app/migrate.ts` and frontend migration code. Do not copy
   the Devnet addresses.

4. Build once:

   ```bash
   anchor build
   ```

5. Deploy the three programs to mainnet using the new mainnet program
   keypairs. Save each transaction signature and run:

   ```bash
   solana program show <PROGRAM_ID> --url mainnet-beta
   ```

6. Create/select the mainnet FOUNDRY staking mint. Set it in the production
   frontend environment, then initialize the reward pool and Merkle keeper.

7. Set production frontend variables:

   ```text
   NEXT_PUBLIC_CLUSTER=mainnet-beta
   NEXT_PUBLIC_RPC_URL=<YOUR_MAINNET_RPC>
   NEXT_PUBLIC_LAUNCHPAD_CORE_PROGRAM_ID=<NEW_MAINNET_CORE_ID>
   NEXT_PUBLIC_REWARD_VAULT_PROGRAM_ID=<NEW_MAINNET_REWARD_ID>
   NEXT_PUBLIC_MERKLE_DISTRIBUTOR_PROGRAM_ID=<NEW_MAINNET_MERKLE_ID>
   NEXT_PUBLIC_LAUNCHPAD_TOKEN_MINT=<MAINNET_FOUNDRY_MINT>
   NEXT_PUBLIC_LAUNCH_METADATA_ENABLED=true
   ```

8. Deploy the frontend. Confirm it says `mainnet-beta` and shows no Devnet
   program ID or Devnet RPC URL.

9. Deploy a separate mainnet Railway keeper service from this repository.
   Give it a **new dedicated mainnet keeper key**, not the Devnet key. Set:

   ```text
   MIGRATION_KEEPER_ENABLED=true
   CLUSTER=mainnet
   SOLANA_RPC_URL=<YOUR_MAINNET_RPC>
   SOLANA_KEEPER_SECRET_KEY=<MAINNET_KEEPER_KEYPAIR_JSON_ARRAY>
   ```

   The current keeper is deliberately Devnet-only, so change that safety gate
   only in the mainnet release after verifying the mainnet Raydium constants.

10. Transfer each program's upgrade authority to the new mainnet Squads
    **Vault PDA**. Verify with `solana program show` after every transfer.

## Part 3: First real launch

1. Create one deliberately small first launch.
2. Confirm create and a small buy work on the public mainnet site.
3. Monitor the keeper logs and your RPC/host dashboards.
4. Do not ask users to click a migration button. The keeper triggers it when
   the curve reaches 85 SOL.

## Important cost clarification

You do not need to personally supply 85–90 SOL to migrate a coin. The 85 SOL
is accumulated in the curve from buyers. The keeper only needs a small SOL
balance for transaction fees and, if it does not exist yet, one WSOL token
account. Program deployment, the mainnet multisig, and first-launch fees are
the mainnet SOL costs you must budget for.
