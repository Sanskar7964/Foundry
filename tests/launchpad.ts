import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { spawn } from "child_process";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import keccak256 from "keccak256";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function airdrop(provider: anchor.AnchorProvider, to: PublicKey, sol: number) {
  const sig = await provider.connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

function pdaOf(program: Program<any>, ...seeds: Buffer[]) {
  return PublicKey.findProgramAddressSync(seeds, program.programId);
}

// Raydium CPMM Devnet addresses. The Surfpool test forks Devnet so these
// program/config accounts are available locally without spending Devnet SOL.
const RAYDIUM_CPMM_DEVNET = new PublicKey("CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW");
const RAYDIUM_AMM_CONFIG_DEVNET = new PublicKey("9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6");
const RAYDIUM_CREATE_POOL_FEE_DEVNET = new PublicKey("G11FKBRaAkHAKuLCgLM6K6NUc9rTjPAznRCjZifrTQe2");

function raydiumPda(seed: string, ...parts: PublicKey[]): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...parts.map((part) => part.toBuffer())],
    RAYDIUM_CPMM_DEVNET,
  )[0];
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe("memecoin-launchpad", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const launchpadCore   = anchor.workspace.LaunchpadCore   as Program<any>;
  const rewardVault     = anchor.workspace.RewardVault     as Program<any>;
  const merkleDistributor = anchor.workspace.MerkleDistributor as Program<any>;

  // ── keypairs ──────────────────────────────────────────────────────────────
  const creator = Keypair.generate();
  const buyer   = Keypair.generate();
  const staker  = Keypair.generate();

  // ── mint/PDAs ─────────────────────────────────────────────────────────────
  let mint: Keypair;
  let curvePda:          PublicKey;
  let curveAuthorityPda: PublicKey;
  let airdropAuthorityPda: PublicKey;
  let curveTreasuryPda:  PublicKey;
  let curveTokenVault:   PublicKey;
  let airdropVault:      PublicKey;

  // ── reward vault PDAs ─────────────────────────────────────────────────────
  // The reward vault uses the LAUNCHPAD governance mint.  For tests we mint a
  // fresh SPL token to stand in as the "staking" token so tests are
  // hermetically sealed — no dependency on an external deployed LAUNCHPAD mint.
  let stakingMint: Keypair;
  let poolPda:     PublicKey;
  let vaultSolPda: PublicKey;
  let stakeVault: PublicKey; // token account initialized by the reward-vault program
  let stakeVaultSigner: Keypair;

  // ─────────────────────────────────────────────────────────────────────────

  before(async () => {
    await Promise.all(
      [creator, buyer, staker].map((kp) => airdrop(provider, kp.publicKey, 10))
    );
    // The migration-threshold test buys through 85 SOL of reserve.
    await airdrop(provider, buyer.publicKey, 100);

    // ── set up staking mint + reward-vault pool ────────────────────────────
    stakingMint = Keypair.generate();

    // We derive the pool PDA before initializing so we can pass it everywhere.
    [poolPda] = pdaOf(
      rewardVault,
      Buffer.from("pool"),
      stakingMint.publicKey.toBuffer()
    );
    [vaultSolPda] = pdaOf(
      rewardVault,
      Buffer.from("vault_sol"),
      stakingMint.publicKey.toBuffer()
    );

    // Create the mint (payer = provider.wallet) – minimal SPL ceremony
    const { createMint, mintTo, createAccount } = await import("@solana/spl-token");
    const conn = provider.connection;
    const walletKey = provider.wallet.publicKey;

    await createMint(conn, (provider.wallet as any).payer, walletKey, null, 6, stakingMint);

    // `initialize_pool` creates this account with the pool PDA as its token
    // authority.  Supplying an unfunded keypair here lets Anchor allocate it.
    stakeVaultSigner = Keypair.generate();
    stakeVault = stakeVaultSigner.publicKey;

    // Mint some staking tokens to the staker wallet (so they can stake later)
    const stakerAta = await createAccount(conn, (provider.wallet as any).payer, stakingMint.publicKey, staker.publicKey);
    await mintTo(conn, (provider.wallet as any).payer, stakingMint.publicKey, stakerAta, walletKey, 1_000_000_000);

    // Initialize reward-vault pool
    await rewardVault.methods
      .initializePool()
      .accounts({
        payer:        provider.wallet.publicKey,
        stakeMint:    stakingMint.publicKey,
        pool:         poolPda,
        vaultSol:     vaultSolPda,
        stakeVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([stakeVaultSigner])
      .rpc();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1.  LAUNCHPAD-CORE
  // ══════════════════════════════════════════════════════════════════════════

  describe("launchpad-core", () => {
    it("rejects airdrop_bps < 100 (min 1%)", async () => {
      const m = Keypair.generate();
      const [curve] = pdaOf(launchpadCore, Buffer.from("curve"), m.publicKey.toBuffer());
      const [auth]  = pdaOf(launchpadCore, Buffer.from("curve_authority"), m.publicKey.toBuffer());
      const [airdropAuth] = pdaOf(launchpadCore, Buffer.from("airdrop_authority"), m.publicKey.toBuffer());
      const [treasury] = pdaOf(launchpadCore, Buffer.from("treasury"), m.publicKey.toBuffer());
      const vault  = await getAssociatedTokenAddress(m.publicKey, auth, true);
      const drop   = await getAssociatedTokenAddress(m.publicKey, airdropAuth, true);

      try {
        await launchpadCore.methods
          .createLaunch("Bad", "BAD", "https://x.com", 50) // 0.5% — too low
          .accounts({
            creator: creator.publicKey, mint: m.publicKey,
            curve, curveAuthority: auth, airdropAuthority: airdropAuth, curveTokenVault: vault,
            airdropVault: drop, curveTreasury: treasury,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([creator, m])
          .rpc();
        assert.fail("should have thrown");
      } catch (e: any) {
        assert.include(e.message, "InvalidAirdropBps");
      }
    });

    it("rejects airdrop_bps > 500 (max 5%)", async () => {
      const m = Keypair.generate();
      const [curve] = pdaOf(launchpadCore, Buffer.from("curve"), m.publicKey.toBuffer());
      const [auth]  = pdaOf(launchpadCore, Buffer.from("curve_authority"), m.publicKey.toBuffer());
      const [airdropAuth] = pdaOf(launchpadCore, Buffer.from("airdrop_authority"), m.publicKey.toBuffer());
      const [treasury] = pdaOf(launchpadCore, Buffer.from("treasury"), m.publicKey.toBuffer());
      const vault  = await getAssociatedTokenAddress(m.publicKey, auth, true);
      const drop   = await getAssociatedTokenAddress(m.publicKey, airdropAuth, true);

      try {
        await launchpadCore.methods
          .createLaunch("Bad2", "BD2", "https://x.com", 600) // 6% — too high
          .accounts({
            creator: creator.publicKey, mint: m.publicKey,
            curve, curveAuthority: auth, airdropAuthority: airdropAuth, curveTokenVault: vault,
            airdropVault: drop, curveTreasury: treasury,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([creator, m])
          .rpc();
        assert.fail("should have thrown");
      } catch (e: any) {
        assert.include(e.message, "InvalidAirdropBps");
      }
    });

    it("creates a launch with 3% airdrop reserve and mints correct supply split", async () => {
      mint = Keypair.generate();
      [curvePda]          = pdaOf(launchpadCore, Buffer.from("curve"),           mint.publicKey.toBuffer());
      [curveAuthorityPda] = pdaOf(launchpadCore, Buffer.from("curve_authority"), mint.publicKey.toBuffer());
      [airdropAuthorityPda] = pdaOf(launchpadCore, Buffer.from("airdrop_authority"), mint.publicKey.toBuffer());
      [curveTreasuryPda]  = pdaOf(launchpadCore, Buffer.from("treasury"),        mint.publicKey.toBuffer());
      curveTokenVault = await getAssociatedTokenAddress(mint.publicKey, curveAuthorityPda, true);
      airdropVault    = await getAssociatedTokenAddress(mint.publicKey, airdropAuthorityPda, true);

      await launchpadCore.methods
        .createLaunch("Doge Vibes", "DVIBE", "https://example.com/meta.json", 300)
        .accounts({
          creator: creator.publicKey,
          mint: mint.publicKey,
          curve: curvePda,
          curveAuthority: curveAuthorityPda,
          airdropAuthority: airdropAuthorityPda,
          curveTreasury: curveTreasuryPda,
          curveTokenVault,
          airdropVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([creator, mint])
        .rpc();

      const curve = await launchpadCore.account.curve.fetch(curvePda);
      assert.equal(curve.airdropBps, 300, "airdrop bps should be 300");
      assert.isFalse(curve.migrated, "should not be migrated yet");
      assert.isFalse(curve.readyToMigrate, "not ready to migrate yet");

      // 3% of 1B tokens = 30M in airdrop, 970M sellable
      const TOTAL  = 1_000_000_000n * 1_000_000n;
      const AIRDROP = TOTAL * 300n / 10_000n;
      const SELLABLE = TOTAL - AIRDROP;
      assert.equal(curve.realTokenReserves.toString(), SELLABLE.toString());
      assert.notEqual(curveTokenVault.toBase58(), airdropVault.toBase58(), "vaults must be distinct");
      const reserve = await getAccount(provider.connection, airdropVault);
      assert.equal(reserve.owner.toBase58(), airdropAuthorityPda.toBase58(), "reserve must be PDA-owned");
    });

    it("does not let the creator transfer tokens out of the airdrop reserve", async () => {
      const { createAccount, transfer } = await import("@solana/spl-token");
      const recipient = await createAccount(
        provider.connection,
        (provider.wallet as any).payer,
        mint.publicKey,
        creator.publicKey
      );

      try {
        await transfer(provider.connection, creator, airdropVault, recipient, creator, 1);
        assert.fail("creator must not control the escrow reserve");
      } catch (e: any) {
        assert.match(e.message, /owner|signature|authority/i);
      }
    });

    it("allows a buyer to buy tokens off the bonding curve", async () => {
      const buyerAta = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          (provider.wallet as any).payer,
          mint.publicKey,
          buyer.publicKey,
        )
      ).address;

      const curveBefore = await launchpadCore.account.curve.fetch(curvePda);
      const solIn = new BN(84 * LAMPORTS_PER_SOL);

      await launchpadCore.methods
        .buy(solIn, new BN(0)) // min_tokens_out = 0 (max slippage for test)
        .accounts({
          buyer: buyer.publicKey,
          curve: curvePda,
          curveAuthority: curveAuthorityPda,
          curveTreasury: curveTreasuryPda,
          curveTokenVault,
          buyerTokenAccount: buyerAta,
          rewardVaultPool: poolPda,
          rewardVaultSol: vaultSolPda,
          rewardVaultProgram: rewardVault.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      const curveAfter = await launchpadCore.account.curve.fetch(curvePda);
      assert.isTrue(
        curveAfter.realSolReserves.gt(curveBefore.realSolReserves),
        "SOL reserves should have increased"
      );
      assert.isTrue(
        curveAfter.realTokenReserves.lt(curveBefore.realTokenReserves),
        "token reserves should have decreased"
      );
      assert.isFalse(
        curveAfter.readyToMigrate,
        "the 1% fee keeps an 84 SOL buy below the 85 SOL migration threshold"
      );

      const buyerTokenAcct = await getAccount(provider.connection, buyerAta);
      assert.isTrue(
        BigInt(buyerTokenAcct.amount) > 0n,
        "buyer should have received tokens"
      );
    });

    it("buy() routes 25% of fee to reward vault", async () => {
      const vaultBefore = await provider.connection.getBalance(vaultSolPda);
      const solIn = new BN(2 * LAMPORTS_PER_SOL);
      const fee = solIn.toNumber() * 100 / 10_000; // 1% fee
      const expectedStakerShare = fee * 2500 / 10_000; // 25%

      const buyerAta = await getAssociatedTokenAddress(mint.publicKey, buyer.publicKey);
      await launchpadCore.methods
        .buy(solIn, new BN(0))
        .accounts({
          buyer: buyer.publicKey,
          curve: curvePda,
          curveAuthority: curveAuthorityPda,
          curveTreasury: curveTreasuryPda,
          curveTokenVault,
          buyerTokenAccount: buyerAta,
          rewardVaultPool: poolPda,
          rewardVaultSol: vaultSolPda,
          rewardVaultProgram: rewardVault.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      const vaultAfter = await provider.connection.getBalance(vaultSolPda);
      assert.approximately(
        vaultAfter - vaultBefore,
        expectedStakerShare,
        1000, // allow 1000 lamport rounding
        "vault should have received 25% of trade fee"
      );
      const curveAfter = await launchpadCore.account.curve.fetch(curvePda);
      assert.isTrue(
        curveAfter.readyToMigrate,
        "a subsequent 2 SOL buy crossing the 85 SOL threshold must mark the curve ready"
      );
    });

    it("sell() returns SOL to seller minus fee", async () => {
      const buyerAta = await getAssociatedTokenAddress(mint.publicKey, buyer.publicKey);
      const tokenAcct = await getAccount(provider.connection, buyerAta);
      const tokensToSell = new BN(tokenAcct.amount.toString()).divn(2); // sell half

      const sellerBalBefore = await provider.connection.getBalance(buyer.publicKey);

      await launchpadCore.methods
        .sell(tokensToSell, new BN(0))
        .accounts({
          buyer: buyer.publicKey,
          curve: curvePda,
          curveAuthority: curveAuthorityPda,
          curveTreasury: curveTreasuryPda,
          curveTokenVault,
          buyerTokenAccount: buyerAta,
          rewardVaultPool: poolPda,
          rewardVaultSol: vaultSolPda,
          rewardVaultProgram: rewardVault.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      const sellerBalAfter = await provider.connection.getBalance(buyer.publicKey);
      assert.isTrue(sellerBalAfter > sellerBalBefore, "seller should have received SOL back");
    });

    it("buy() reverts with SlippageExceeded when min_tokens_out is too high", async () => {
      const buyerAta = await getAssociatedTokenAddress(mint.publicKey, buyer.publicKey);
      try {
        await launchpadCore.methods
          .buy(new BN(0.01 * LAMPORTS_PER_SOL), new BN(Number.MAX_SAFE_INTEGER))
          .accounts({
            buyer: buyer.publicKey,
            curve: curvePda,
            curveAuthority: curveAuthorityPda,
            curveTreasury: curveTreasuryPda,
            curveTokenVault,
            buyerTokenAccount: buyerAta,
            rewardVaultPool: poolPda,
            rewardVaultSol: vaultSolPda,
            rewardVaultProgram: rewardVault.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown SlippageExceeded");
      } catch (e: any) {
        assert.include(e.message, "SlippageExceeded");
      }
    });

    it("Surfpool: keeper automatically migrates a ready curve through Raydium", async function () {
      // This test needs Surfpool's local Devnet fork for the Raydium CPMM
      // program/config. It is deliberately opt-in so ordinary `anchor test`
      // stays fully local and does not depend on an external program.
      if (process.env.SURFPOOL_MIGRATION_TEST !== "true") this.skip();

      const keeper = Keypair.generate();
      await airdrop(provider, keeper.publicKey, 5);

      const readyCurve = await launchpadCore.account.curve.fetch(curvePda);
      assert.isTrue(readyCurve.readyToMigrate, "curve must have crossed the 85 SOL threshold");
      assert.notEqual(
        keeper.publicKey.toBase58(),
        creator.publicKey.toBase58(),
        "test caller must not be the launch creator",
      );

      const [token0Mint, token1Mint] = mint.publicKey.toBuffer().compare(NATIVE_MINT.toBuffer()) < 0
        ? [mint.publicKey, NATIVE_MINT]
        : [NATIVE_MINT, mint.publicKey];
      const poolState = raydiumPda("pool", RAYDIUM_AMM_CONFIG_DEVNET, token0Mint, token1Mint);
      const lpMint = raydiumPda("pool_lp_mint", poolState);
      const creatorLpToken = getAssociatedTokenAddressSync(lpMint, curveAuthorityPda, true);

      // Use the exact process Railway runs. It polls the local Surfpool RPC,
      // discovers this ready curve by account layout, then invokes migrate.ts
      // with this non-creator keeper's keypair.
      const keeperProcess = spawn(
        process.execPath,
        ["node_modules/ts-node/dist/bin.js", "app/migration-keeper.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MIGRATION_KEEPER_ENABLED: "true",
            MIGRATION_KEEPER_POLL_MS: "100",
            CLUSTER: "devnet",
            SOLANA_RPC_URL: process.env.ANCHOR_PROVIDER_URL!,
            SOLANA_KEEPER_SECRET_KEY: JSON.stringify(Array.from(keeper.secretKey)),
            MIGRATION_KEEPER_MINT: mint.publicKey.toBase58(),
          },
          stdio: "inherit",
        },
      );

      try {
        const deadline = Date.now() + 20_000;
        let migrated = false;
        while (Date.now() < deadline) {
          const currentCurve = await launchpadCore.account.curve.fetch(curvePda);
          if (currentCurve.migrated) {
            migrated = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.isTrue(migrated, "keeper must migrate the curve within 20 seconds");
      } finally {
        keeperProcess.kill("SIGTERM");
      }

      const migratedCurve = await launchpadCore.account.curve.fetch(curvePda);
      assert.isTrue(migratedCurve.migrated, "permissionless migration must mark the curve migrated");
      assert.isNotNull(await provider.connection.getAccountInfo(poolState), "Raydium pool must exist");
      const lpAccount = await getAccount(provider.connection, creatorLpToken);
      assert.equal(lpAccount.amount.toString(), "0", "all LP tokens must be burned");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2.  REWARD-VAULT
  // ══════════════════════════════════════════════════════════════════════════

  describe("reward-vault", () => {
    let stakerAta: PublicKey;
    let userStakePda: PublicKey;

    before(async () => {
      stakerAta = await getAssociatedTokenAddress(stakingMint.publicKey, staker.publicKey);
      [userStakePda] = pdaOf(
        rewardVault,
        Buffer.from("user"),
        poolPda.toBuffer(),
        staker.publicKey.toBuffer()
      );
    });

    it("stake() deposits tokens and creates user-stake PDA", async () => {
      const stakeAmount = new BN(500_000_000); // 500 tokens (6 dec)
      await rewardVault.methods
        .stake(stakeAmount)
        .accounts({
          owner: staker.publicKey,
          pool: poolPda,
          userStake: userStakePda,
          userTokenAccount: stakerAta,
          stakeVault,
          vaultSol: vaultSolPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([staker])
        .rpc();

      const poolState = await rewardVault.account.pool.fetch(poolPda);
      assert.equal(poolState.totalStaked.toString(), stakeAmount.toString());
      assert.equal(
        poolState.unallocatedFees.toString(),
        "0",
        "fees collected before the first stake should become claimable immediately"
      );
      assert.isTrue(
        poolState.accRewardPerShare.gt(new BN(0)),
        "the first stake should receive the previously parked fees"
      );

      const userState = await rewardVault.account.userStake.fetch(userStakePda);
      assert.equal(userState.amount.toString(), stakeAmount.toString());
    });

    it("stake() with zero amount reverts", async () => {
      try {
        await rewardVault.methods
          .stake(new BN(0))
          .accounts({
            owner: staker.publicKey,
            pool: poolPda,
            userStake: userStakePda,
            userTokenAccount: stakerAta,
            stakeVault,
            vaultSol: vaultSolPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([staker])
          .rpc();
        assert.fail("should have thrown ZeroAmount");
      } catch (e: any) {
        assert.include(e.message, "ZeroAmount");
      }
    });

    it("claim() pays SOL to staker after fees are deposited", async () => {
      // The buy() calls above already sent lamports to vault_sol via CPI.
      // Just confirm the staker can now claim their share.
      const stakerBalBefore = await provider.connection.getBalance(staker.publicKey);

      await rewardVault.methods
        .claim()
        .accounts({
          owner: staker.publicKey,
          pool: poolPda,
          userStake: userStakePda,
          vaultSol: vaultSolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([staker])
        .rpc();

      const stakerBalAfter = await provider.connection.getBalance(staker.publicKey);
      assert.isTrue(stakerBalAfter > stakerBalBefore, "staker should receive SOL rewards");
    });

    it("claim() reverts with NothingToClaim when called twice with no new fees", async () => {
      try {
        await rewardVault.methods
          .claim()
          .accounts({
            owner: staker.publicKey,
            pool: poolPda,
            userStake: userStakePda,
            vaultSol: vaultSolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([staker])
          .rpc();
        assert.fail("should have thrown NothingToClaim");
      } catch (e: any) {
        assert.include(e.message, "NothingToClaim");
      }
    });

    it("unstake() returns tokens and unstake fails if amount > staked", async () => {
      const userState = await rewardVault.account.userStake.fetch(userStakePda);
      const overAmount = new BN(userState.amount.toString()).addn(1);

      try {
        await rewardVault.methods
          .unstake(overAmount)
          .accounts({
            owner: staker.publicKey,
            pool: poolPda,
            userStake: userStakePda,
            userTokenAccount: stakerAta,
            stakeVault,
            vaultSol: vaultSolPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([staker])
          .rpc();
        assert.fail("should have thrown InsufficientStake");
      } catch (e: any) {
        assert.include(e.message, "InsufficientStake");
      }

      // Valid unstake of the whole balance
      await rewardVault.methods
        .unstake(new BN(userState.amount.toString()))
        .accounts({
          owner: staker.publicKey,
          pool: poolPda,
          userStake: userStakePda,
          userTokenAccount: stakerAta,
          stakeVault,
          vaultSol: vaultSolPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([staker])
        .rpc();

      const poolAfter = await rewardVault.account.pool.fetch(poolPda);
      assert.equal(poolAfter.totalStaked.toString(), "0");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3.  MERKLE-DISTRIBUTOR  (structural / smoke tests)
  //     Full merkle-proof tests require off-chain tree generation.
  //     See app/build-merkle-tree.ts for the snapshot-to-root pipeline.
  // ══════════════════════════════════════════════════════════════════════════

  describe("merkle-distributor integration", () => {
    const keeper = Keypair.generate();
    const epoch = new BN(1);
    const claimAmount = new BN(5_000_000);
    let keeperConfig: PublicKey;
    let distributor: PublicKey;
    let epochVault: PublicKey;
    let receipt: PublicKey;

    before(async () => {
      await airdrop(provider, keeper.publicKey, 2);
      [keeperConfig] = pdaOf(merkleDistributor, Buffer.from("keeper_config"));
      await merkleDistributor.methods.initializeKeeper(keeper.publicKey)
        .accounts({ payer: keeper.publicKey, config: keeperConfig, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc();

      const epochBytes = Buffer.alloc(8);
      epochBytes.writeBigUInt64LE(BigInt(epoch.toString()));
      [distributor] = pdaOf(merkleDistributor, Buffer.from("distributor"), mint.publicKey.toBuffer(), epochBytes);
      epochVault = await getAssociatedTokenAddress(mint.publicKey, distributor, true);
      [receipt] = pdaOf(merkleDistributor, Buffer.from("receipt"), distributor.toBuffer(), buyer.publicKey.toBuffer());

      const amountBytes = Buffer.alloc(8);
      amountBytes.writeBigUInt64LE(BigInt(claimAmount.toString()));
      const root = keccak256(Buffer.concat([buyer.publicKey.toBuffer(), amountBytes]));
      await merkleDistributor.methods.createDistributor(epoch, Array.from(root), claimAmount)
        .accounts({
          authority: keeper.publicKey, keeperConfig, mint: mint.publicKey, distributor, epochVault,
          tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        }).signers([keeper]).rpc();

      await launchpadCore.methods.fundDistributor(claimAmount)
        .accounts({
          creator: creator.publicKey, curve: curvePda, airdropAuthority: airdropAuthorityPda,
          airdropVault, distributor, epochVault, tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([creator]).rpc();
    });

    it("pays a valid claim from the program-funded epoch", async () => {
      const claimantAta = await getAssociatedTokenAddress(mint.publicKey, buyer.publicKey);
      const before = (await getAccount(provider.connection, claimantAta)).amount;
      await merkleDistributor.methods.claim(epoch, claimAmount, [])
        .accounts({
          claimant: buyer.publicKey, distributor, epochVault, claimantTokenAccount: claimantAta, receipt,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([buyer]).rpc();
      const after = (await getAccount(provider.connection, claimantAta)).amount;
      assert.equal((after - before).toString(), claimAmount.toString());
      assert.equal((await merkleDistributor.account.distributor.fetch(distributor)).claimedAmount.toString(), claimAmount.toString());
    });

    it("rejects a double claim", async () => {
      const claimantAta = await getAssociatedTokenAddress(mint.publicKey, buyer.publicKey);
      try {
        await merkleDistributor.methods.claim(epoch, claimAmount, [])
          .accounts({
            claimant: buyer.publicKey, distributor, epochVault, claimantTokenAccount: claimantAta, receipt,
            tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          }).signers([buyer]).rpc();
        assert.fail("second claim must fail");
      } catch (e: any) {
        assert.match(e.message, /already in use|already initialized|AccountAlreadyInitialized/i);
      }
    });
  });

  describe("merkle-distributor (smoke)", () => {
    it("placeholder: second claim with same proof must fail (double-spend guard)", async () => {
      // Full flow:
      //  1. run `ts-node app/build-merkle-tree.ts` to get {root, proofs}
      //  2. createDistributor(epoch, root, totalAmount)
      //  3. claim(epoch, amount, proof) -> succeeds (receipt PDA init'd)
      //  4. claim(epoch, amount, proof) again -> must throw (PDA already exists)
      //
      // Skipping here because it requires a real merkle tree fixture.
      // TODO: add a fixture-based test once app/build-merkle-tree.ts is wired up.
      assert.ok(true, "placeholder — see comment above");
    });
  });
});
