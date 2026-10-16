# Local permissionless migration test

This test runs entirely on your computer. It does not call Railway, modify
Devnet, spend Devnet SOL, or require mainnet SOL.

It starts from the existing Anchor test flow, which funds its generated buyer
with 100 local SOL, crosses the real 85 SOL migration threshold, then starts
the same `migration-keeper.ts` process used by Railway. That random
non-creator keeper discovers and migrates the curve through a locally forked
copy of Devnet Raydium CPMM.

## One-time setup

Run these commands in the VS Code WSL terminal:

```bash
cd /mnt/c/dev
surfpool --version
```

If that prints a version, continue. If it says `command not found`, install
Surfpool using Solana's WSL installer, then restart the terminal:

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
```

## Run the test

1. Open terminal one in VS Code and run:

```bash
cd /mnt/c/dev
surfpool start --network devnet --legacy-anchor-compatibility --airdrop-keypair-path ~/.config/solana/id.json --airdrop-amount 200000000000 --no-tui
```

Leave this terminal running. It is a local simulator at
`http://127.0.0.1:8899`; `--network devnet` only gives the simulator access to
Raydium program/config data.

Surfpool deploys the compiled programs from `target/deploy` when it starts.
Do not use a separate `anchor deploy` command.

2. Open terminal two and run:

```bash
cd /mnt/c/dev
bash scripts/test-surfpool-migration.sh
```

The script automatically uses `~/.config/solana/id.json` to sign **local**
Surfpool transactions. To use a different local test keypair, run:

```bash
ANCHOR_WALLET=/path/to/test-keypair.json bash scripts/test-surfpool-migration.sh
```

3. The script compiles the TypeScript tests locally, then runs Mocha directly.
This avoids a Node/`ts-mocha` module-loader incompatibility; it does not deploy
anything. A pass ends with Mocha reporting the test named:

```text
Surfpool: keeper automatically migrates a ready curve through Raydium
```

The test asserts all of the following:

- the real 85 SOL threshold is reached;
- the Railway-style keeper discovers the ready curve and performs `mark_migrated`;
- the Raydium pool was created;
- the curve is marked migrated; and
- LP token balance is zero (LP burned).

The command intentionally excludes the reward-vault and Merkle-distributor
test suites. They use global fixture PDAs which already exist in a Devnet fork
and are not part of this migration test. Their normal local-validator tests
remain unchanged.

It also excludes the airdrop-escrow ownership assertion because Surfpool can
expire that separate test's confirmation blockhash. That ownership behavior is
not used by migration and remains covered by the normal local-validator suite.

The migration script prints a Devnet-style explorer URL because it uses
Devnet Raydium addresses. During this test the transaction is local to
Surfpool, so do not treat that URL as a Devnet transaction record.

4. Stop terminal one with `Ctrl+C` when finished. All test state disappears.
