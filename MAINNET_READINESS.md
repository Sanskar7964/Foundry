# Memecoin Launchpad — Mainnet Readiness Tracker

## Fix Status

| # | Fix | Status |
|---|-----|--------|
| 1 | `mark_migrated` authority guard (`has_one = authority`) | ✅ Done |
| 2 | Raydium CPMM migration CPI (atomic SOL wrap + pool create + LP burn) | ✅ Done |
| 3 | Keeper authority for merkle-distributor | ✅ Done |
| 4 | Zero-staked fee bug in reward-vault | ✅ Done |

All four fixes build cleanly (`anchor build` exit 0, warnings only).

## Current Status (October 2026)

This section supersedes the older C--E notes below.

### C. Treasury bump handling - complete

`Migrate` derives the treasury PDA through its Anchor account constraint and
uses `ctx.bumps.curve_treasury` for PDA signing. A cached bump is intentionally
not added to `Curve`, because changing that account layout would make upgrades
incompatible with existing launches.

### D. Merkle-distributor integration - implemented, execution pending

`tests/launchpad.ts` now exercises: keeper initialization, a Keccak
single-leaf root, distributor creation, PDA-signed `fund_distributor`, a valid
claim, and rejection of a duplicate claim. The programs build successfully.

The local execution is blocked by the installed `solana-test-validator 4.2.2`:
it rejects deployment of the freshly built program with `invalid account data`.
This is a local validator/toolchain issue, not an on-chain test result. Align
the local Solana version with Anchor before running `anchor test`, or run the
flow against a fresh, explicitly selected Devnet launch.

### E. Security review - partially complete

- [x] Buy and sell reject calls after migration.
- [x] Raydium mint sorting was exercised by the successful Devnet migration.
- [x] Buy/sell curve arithmetic now uses checked `u128` math and checked
  conversions; overflow returns `MathOverflow` rather than panicking.
- [x] The test covers the threshold edge: an 84 SOL buy remains below the
  85 SOL real-reserve threshold after fees; a subsequent 2 SOL buy crosses it.
- [ ] Execute the integration suite after aligning the local validator.
- [ ] Add randomized/property tests over buy/sell amount and reserve ranges.
- [ ] Run the full Merkle flow against a fresh Devnet test launch.

> [!IMPORTANT]
> `MIGRATION_SOL_THRESHOLD` is set to **85 SOL** for the intended mainnet
> deployment. The UI progress calculation and threshold-edge test use the same
> value.

---

## What To Do Next

Follow [`DEVNET_RELEASE_RUNBOOK.md`](DEVNET_RELEASE_RUNBOOK.md) for the
ordered Devnet-only release rehearsal and the evidence required before any
mainnet spending.

### 🔴 Must-do before mainnet

#### A. End-to-end integration test for migration
The migration path has **never been tested on-chain** — it's the highest-risk area.

1. Deploy to **devnet** with `anchor deploy`
2. Run `app/migrate.ts` against a test coin that has hit the 85 SOL threshold
3. Verify on Solscan:
   - `pool_state` account created with correct reserves
   - `lp_mint` supply = 0 (all LP burned)
   - `curve.migrated = true`
4. Try swapping on the Raydium devnet UI against the new pool

> [!IMPORTANT]
> The Raydium devnet AMM config address and `create_pool_fee` in `app/migrate.ts` **must be verified** against Raydium's own devnet deployment.  
> Check: https://github.com/raydium-io/raydium-cp-swap or their REST API (`https://api-v3.raydium.io/main/pool/config/list`).

#### B. Verify AMM config & fee addresses per cluster
In [`app/migrate.ts`](file:///c:/dev/app/migrate.ts) lines 43–55, confirm:
- `AMM_CONFIG.devnet` / `AMM_CONFIG.mainnet`
- `CREATE_POOL_FEE.devnet` / `CREATE_POOL_FEE.mainnet`

These are **not** derived — they are fixed addresses Raydium deploys. Wrong values = tx failure.

#### C. Treasury bump stored in Curve account (or passed via constraint)
The `Migrate` struct uses `seeds = [b"treasury", curve.mint.as_ref()], bump` — Anchor re-derives the bump at runtime.  
If you later want to cache it (gas micro-optimisation), store `curve_treasury_bump` in `Curve`. Not strictly required now.

#### D. Merkle-distributor airdrop integration test
The keeper flow (initialize_keeper / create_distributor) has never been tested on devnet either.  
Write one full flow test: snapshot → compute merkle root off-chain → `create_distributor` → `claim`.

#### E. Security audit checklist
- [ ] Verify no SOL can be drained from `curve_treasury` after `migrated = true` (no sell path, ✓ guarded by `!migrated`)
- [ ] Confirm Raydium's `initialize` will reject if `token_0_mint >= token_1_mint` (it does — our sort handles this)
- [ ] Fuzz the buy/sell math around `MIGRATION_SOL_THRESHOLD` boundary
- [ ] Check for integer overflow in `k = vsol * vtok` when both are near `u64::MAX` (unlikely at 85 SOL scale but worth bounding)

---

### 🟡 Should-do before mainnet

#### F. UI: Migration trigger button
Currently no frontend calls `mark_migrated`. The creator needs a UI button that:
1. Checks `curve.ready_to_migrate == true && curve.migrated == false`
2. Calls the `migrate.ts` logic (or equivalent in the frontend SDK)
3. Shows the resulting Raydium pool link

#### G. UI: Progress bar to migration threshold
Show users how far a coin is from 85 SOL (pump.fun-style "bonding curve progress").

Status: complete. Coin pages now render a live constant-product curve marker
and on-chain reserve progress toward 85 SOL.

#### H. Fee parameters — decide final values
| Parameter | Current | Recommended range |
|-----------|---------|------------------|
| `TRADE_FEE_BPS` | 100 (1%) | 50–200 bps |
| `FEE_SHARE_TO_STAKERS_BPS` | 2500 (25%) | 20–30% |
| `MIGRATION_SOL_THRESHOLD` | 85 SOL | market-dependent |

Status: approved for mainnet: 100 bps trade fee, 25% of fees to stakers, and
an 85 SOL migration threshold.

These are compile-time constants — changing post-deploy requires a program upgrade.

#### I. Program upgrade authority

Status: approved: use a Squads multisig. First create and rehearse with a
Devnet Squad, including a devnet program-authority transfer. Do not hardcode
its Vault address: the final mainnet Vault address is created and recorded only
on deployment day, immediately before transferring mainnet program authority.

Devnet rehearsal Squad (2-of-3, created October 12, 2026):

| Item | Address |
|---|---|
| Multisig PDA | `C4WBJRjmLUJwUkFxD9CaBopspDpeFkeniRAK7Bt7ML7F` |
| Vault PDA — devnet upgrade authority | `` |
| Treasury | `HM5y4mz3Bt9JY9mr1hkyhnvqxSH4H2u2451j7Hc2dtvK` |
| Creation transaction | `5RN2CfqpbmkdDDdeBAp9xuyp7pJcSAgbjzJxDsUyJU9BPfP6MiEyFFy7xmVWidwAYEpaVH3UszudbUJ8i4FNoi4V` |

Use the **Vault PDA**, never the Multisig PDA, as the program upgrade authority.
Before mainnet, decide:
- **Freeze** the upgrade authority (immutable program) — maximum trust, no bug fixes possible
- **Multisig** via Squads / SPL Governance — recommended for production

#### J. Add `npm run migrate` script to package.json
```json
"migrate": "ts-node app/migrate.ts"
```

Status: complete. Run it as `CLUSTER=mainnet npm run migrate -- <MINT_PUBKEY>`
for production (the default is Devnet), with `ANCHOR_WALLET` (or
`SOLANA_WALLET_PATH`) and an RPC URL supplied through `ANCHOR_PROVIDER_URL`
(or `SOLANA_RPC_URL`).

---

### 🟢 Nice-to-have

#### K. Anchor tests for migration
Add a test in `tests/launchpad.ts` that:
- Creates a launch, pumps it past threshold via repeated buys
- Calls `markMigrated` against a mock CPMM (or a local validator with the Raydium program loaded via `--bpf-program`)

#### L. Emit pool address in CurveMigrated event
Currently `CurveMigrated { mint, real_sol_reserves }`.  
Consider adding `pool_state: Pubkey` so indexers can track it without re-deriving.

#### M. Reward-vault: UI for stakers to claim
Status: source implementation complete. The page now reads Pool and UserStake
accounts, shows actual stake/reward values, and submits stake, unstake, and
claim actions. Deploy and exercise the updated reward-vault on Devnet before
relying on it in production.

The claim page now consumes keeper-published Merkle proofs rather than demo
entries. Publish each epoch in `frontend/public/airdrop-claims.json` (or set
`NEXT_PUBLIC_AIRDROP_CLAIMS_URL` to an external manifest) as described in
`frontend/AIRDROP_CLAIMS.md`.

---

## Migration Script Quick Reference

```bash
# Devnet
ANCHOR_WALLET=~/.config/solana/id.json \
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ts-node app/migrate.ts <MINT_PUBKEY>

# Mainnet (change CLUSTER="mainnet" in migrate.ts first)
ANCHOR_WALLET=~/.config/solana/id.json \
ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
ts-node app/migrate.ts <MINT_PUBKEY>
```

## Key Addresses

| Thing | Devnet | Mainnet |
|-------|--------|---------|
| Raydium CPMM Program | `CPMDWBwJ...` | `CPMMoo8L...` |
| Launchpad Program | `HbYcvC9n...` | *(redeploy for mainnet)* |
| WSOL Mint | `So1111...112` | same |
