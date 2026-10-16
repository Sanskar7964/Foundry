# Devnet Release Runbook

This is the remaining work before any mainnet spending. It applies to your
**existing Devnet deployment and existing Devnet program IDs**. Do not create
new IDs or repeat a test that has already passed on the current code.

## Scope and rule

- Use Devnet wallets, Devnet SOL, and the Devnet Squads Vault only.
- Do not create a mainnet Squad, deploy a mainnet program, or transfer any
  mainnet authority during this runbook.
- Do not lower the committed 85 SOL migration threshold in the production
  source. If Devnet funding is a constraint, use a separately identified test
  deployment for the threshold rehearsal.

## First: do not reset your Devnet setup

Keep all of these exactly as they are unless you intentionally deploy a
different application:

- Existing Devnet program IDs in `Anchor.toml` and `frontend/.env.local`.
- Existing Devnet FOUNDRY mint, reward pool, keeper, and test coins.
- Existing Devnet Squads multisig.

Creating a new program ID creates a separate application deployment. It is
useful for an isolated experiment, but is **not** a release requirement. A
normal program upgrade keeps the same ID and replaces its code using the
upgrade-authority wallet.

## Current verified Devnet deployment

These are deployed and executable on Devnet. They are the only program IDs to
use for the current application:

| Program | Devnet program ID |
|---|---|
| Launchpad core | `HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn` |
| Reward vault | `3xUJqsjCQBfvUhEvz5cd16SSAwLdQUFGijoh3X5pLYPZ` |
| Merkle distributor | `GtpFjU1NZM8NvE2UYfNxszmTL2SW2xU6z4318by8rYC7` |

They now match `Anchor.toml`, the Rust `declare_id!` values, frontend IDLs,
and `frontend/.env.local`.

## One pending source upgrade: save coin names and tickers

This repository now saves a coin's name, ticker, and metadata URI in a new
PDA. It does **not** modify the live `Curve` account layout, your reward pool,
or any existing coin balance. New launches save these fields automatically;
the original creator of an older launch can add them from that coin's page.

Do this once on Devnet when you are ready. It upgrades the existing launchpad
program `HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn`; do not generate a
program keypair and do not change an environment variable.

1. In WSL, build the program:

   ```bash
   cd /mnt/c/dev
   anchor build
   ```

   **Do not run `anchor deploy`, `anchor keys sync`, or use
   `target/deploy/launchpad_core-keypair.json`.** That local keypair belongs
   to the old, broken `DFB…` deployment and is not the live program. It is
   not needed for a Squad-approved buffer upgrade.

   Check that the generated IDL identifies the correct live program:

   ```bash
   grep '"address"' target/idl/launchpad_core.json | head -1
   ```

   Stop unless it prints
   `HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn`.

2. **Do not copy that new IDL into the running frontend yet.** Until the
   Squad transaction is executed, the existing frontend must keep
   `NEXT_PUBLIC_LAUNCH_METADATA_ENABLED=false`; otherwise a new launch will
   send the wrong account order to the old program.

3. Check the program authority. It must be the existing Devnet Vault PDA:

   ```bash
   solana program show HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn --url devnet
   ```

   Confirm that `Authority` is
   `4JVEDPJpRMP9Uz4VQop9Y71Cf9QkonEAqmhXobDMx1hK`. If it is not, stop here.

4. Write an upgrade buffer only; this does not change the program yet:

   ```bash
   solana program write-buffer target/deploy/launchpad_core.so --url devnet
   ```

   Copy the buffer address printed by the command. Then hand the buffer to the
   Vault so the Squad can use it:

   ```bash
   solana program set-buffer-authority <BUFFER_ADDRESS> \
     --new-buffer-authority 4JVEDPJpRMP9Uz4VQop9Y71Cf9QkonEAqmhXobDMx1hK \
     --url devnet
   ```

   If the proposal script reports that `ProgramData needs <NUMBER> more
   bytes`, extend it from a Devnet-funded wallet before creating the proposal:

   ```bash
   solana program extend HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn <NUMBER> --url devnet
   ```

   This changes allocation only; it does not change program code or authority.

5. Use the included Devnet scripts; do not use the Squad UI and do not use
   mainnet SOL. The first command creates the proposal and records member 1's
   approval. Use the buffer address from step 4 exactly as printed:

   ```bash
   npm run squad:propose-upgrade -- \
     "$(wslpath -w /home/sansk/.config/solana/squad-members/member1.json)" \
     <BUFFER_ADDRESS>
   ```

   It prints `Devnet proposal index: <NUMBER>`. Copy that number, then run
   this as member 2. It submits the second approval and executes the upgrade:

   ```bash
   npm run squad:approve-execute -- \
     "$(wslpath -w /home/sansk/.config/solana/squad-members/member2.json)" \
     <NUMBER>
   ```

   Both scripts use only `https://api.devnet.solana.com`, the existing Devnet
   multisig `C4WB…`, and its Vault `4JVED…`. They refuse to proceed if the
   program or buffer authority is not that Vault. Save the execution signature
   printed by the second command.

6. Only after that transaction succeeds, enable the matching frontend code:

   ```bash
   cp target/idl/launchpad_core.json frontend/lib/anchor/idl/launchpad_core.json
   ```

   In `frontend/.env.local`, change exactly this one line:

   ```text
   NEXT_PUBLIC_LAUNCH_METADATA_ENABLED=true
   ```

   Then rebuild/restart the frontend:

   ```bash
   npm.cmd run build --prefix frontend
   ```

7. Refresh the frontend. Create one small Devnet launch. Its name and ticker
   must appear on the home page and coin page. This is the only new functional
   check needed for this feature. For an old launch, connect its creator wallet
   and use **Add coin details** once; there is no way to recover the discarded
   historical fields automatically.

## What to do now (only if source changed after your 16 passing tests)

If the 16 tests ran after the latest reward-vault/frontend changes, skip this
section. If they ran before those changes, do only this using your existing
program IDs:

1. Run `anchor build` in your normal Solana/Anchor terminal.
2. Copy fresh `target/idl/*.json` files over the matching
   `frontend/lib/anchor/idl/` files.
3. Upgrade/deploy with the same program keypairs and existing Devnet
   upgrade-authority wallet. Do **not** generate keypairs or edit program IDs.
4. Run `npm.cmd run build --prefix frontend`.
5. Test `Stake -> Claim -> Unstake` once.

Stop if an upgrade asks for a program ID you do not recognise. Do not change
environment variables to make it work; ask here with the command output.

## Already completed tests

If your 16 cases include launch creation, buy, sell, stake, claim, and
unstake, sections 2--4 below are already complete. Keep their transaction
links or screenshots; do not rerun them.

## Day 1 — reproducible build and core flows

### 1. Record the working Devnet toolchain

The Rust programs and `Anchor.toml` use Anchor **0.31.1**. The current working
Devnet setup is Solana CLI 4.2.2, Anchor CLI 0.31.1, and Rust 1.98.1. Use that
environment for this runbook; no toolchain change is required merely to test
on remote Devnet.

Record these outputs in the release notes:

```bash
solana --version
anchor --version
rustc --version
```

Run:

```bash
anchor build
anchor test
```

Pass condition: all programs build and fresh `target/idl/*.json` files are
copied into `frontend/lib/anchor/idl/` before rebuilding the frontend.

The local `solana-test-validator` bundled with Solana CLI 4.2.2 has previously
rejected a freshly built program with `invalid account data`. That affects only
local-validator `anchor test` execution, not remote Devnet. Treat the Devnet
rehearsals in this runbook as the release gate. Investigate local-validator
version alignment separately if you need fast hermetic tests.

### 2. Program deployment (already complete unless source changed)

Use the existing program IDs. A new ID is not required. After an intentional
program upgrade, verify that the same ID has the expected temporary upgrade
authority:

```bash
solana program show <YOUR_EXISTING_PROGRAM_ID> --url devnet
```

### 3. Platform setup (do not recreate if it already works)

Keep the FOUNDRY mint, reward pool, and keeper that your tests already used.
Only initialize one of these if it does not exist or was never tested.

### 4. Manual core launch test (already complete if included in your 16 tests)

Create a new coin from the frontend, then complete this table using two
different Devnet wallets.

| Action | Pass condition |
|---|---|
| Create launch | Mint, Curve PDA, curve treasury, token vault, and airdrop vault exist on Devnet. |
| First buy | Buyer receives tokens; curve reserves, price, chart marker, and progress bar update without a page reload. |
| Second buy | Fee reaches the reward SOL vault and pool fee accounting increases. |
| Sell | Seller receives the expected SOL net of fee; curve reserves update. |
| Stake FOUNDRY | Stake page shows actual stake, not demo data. |
| Claim staking reward | Claim transfers SOL once; an immediate second claim fails with `NothingToClaim`. |
| Unstake | Staked tokens return and any pending reward is paid first. |

Save transaction links and screenshots of the coin, claim, and stake pages.

## Day 2 — airdrop, migration, authority, and abuse checks

### 5. Full holder-airdrop flow

For one test coin and a holder wallet:

1. Snapshot holders and calculate entitlements.
2. Build a Merkle root/proofs with `app/build-merkle-tree.ts` or the keeper
   workflow.
3. Create a distributor epoch as the registered keeper.
4. Fund it from the launch creator via `fund_distributor`.
5. Publish the holder claim entry in `frontend/public/airdrop-claims.json`.
   The exact JSON schema is in `frontend/AIRDROP_CLAIMS.md`.
6. Connect the eligible holder. The claim page must show the actual mint,
   epoch, and amount.
7. Claim successfully, then attempt the same claim again.

Pass condition: the first claim transfers the right amount, and the second is
rejected because the receipt PDA already exists. Save root, manifest hash,
epoch distributor/vault addresses, and both transaction results.

### 6. 85 SOL migration rehearsal

This is the highest-risk test. Fund the Devnet test wallets sufficiently to
reach **85 SOL after fees**. If the public faucet cannot provide enough funds,
use a separately labelled Devnet test deployment; never change the production
85 SOL constant just to make the test easier.

1. Buy enough to leave reserves below 85 SOL; `ready_to_migrate` stays false.
2. Make the final buy; `ready_to_migrate` becomes true.
3. From a connected **non-creator** Devnet wallet, migrate using the UI or
   `app/migrate.ts`. The caller only pays the transaction fee (and possibly a
   one-time WSOL ATA rent); Raydium setup is funded from the curve treasury's
   accrued fee surplus. This verifies the permissionless migration upgrade.
4. Verify on an explorer: pool state exists, both reserves are correct, LP mint
   supply is zero, and `curve.migrated` is true.
5. Swap against the Devnet Raydium pool.
6. Attempt another curve buy and sell; both must fail after migration.

Before this test, independently verify the Devnet Raydium AMM config and
create-pool-fee account in `app/migrate.ts` against Raydium's current docs.
Save the verification source/date and every transaction link.

### 7. Devnet Squads rehearsal

After the functional tests pass:

1. Add the deployed programs to the Devnet Squad.
2. Transfer each upgrade authority to the **Devnet Vault PDA**
   `4JVEDPJpRMP9Uz4VQop9Y71Cf9QkonEAqmhXobDMx1hK`, never the Multisig PDA.
3. Propose, approve (2-of-3), and execute one harmless Devnet program upgrade.
4. Verify the authority and final deployed bytecode on an explorer.

Pass condition: no individual wallet can upgrade a program after transfer, but
the approved Squad transaction can.

### 8. Manual negative-path checks

- A non-creator cannot migrate a curve.
- A non-keeper cannot create a distributor.
- A holder cannot claim an invalid proof, a wrong amount, or twice.
- A user cannot unstake more than staked.
- A user with no pending reward cannot claim.
- A malformed/unknown mint in the frontend fails safely without a transaction.

Record the failing transaction/simulation message for every check.

## Mainnet go/no-go gates

Do not spend mainnet SOL until every item is true:

- [ ] Toolchain versions are pinned and reproducible.
- [ ] Fresh IDLs match deployed Devnet source and the frontend production build passes.
- [ ] Sections 4–8 have saved Devnet evidence.
- [ ] Raydium mainnet config/fee addresses are independently verified on the deployment date.
- [ ] An external security review and legal review are complete or explicitly accepted as a business risk.
- [ ] A production keeper policy exists: snapshot cadence, sybil policy, proof hosting, manifest integrity, and incident ownership.
- [ ] Mainnet RPC, monitoring, alerts, backups, and incident contacts are selected.
- [ ] A separate mainnet Squads Vault is created and all members have verified recovery procedures.

Once these gates pass, create a dated mainnet deployment checklist from the
saved Devnet addresses and transactions. The mainnet Vault and real SOL are
only needed at that final stage.
