/**
 * migrate.ts — Call `mark_migrated` on the launchpad-core program.
 *
 * This script derives every account the Raydium CPMM `initialize` instruction
 * needs, builds the full account list, and sends the transaction.
 *
 * Usage:
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ts-node app/migrate.ts <MINT_PUBKEY>
 *
 * For mainnet swap the program IDs and fee addresses below.
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────
//  Cluster-specific constants
//  Swap these blocks when targeting mainnet.
// ─────────────────────────────────────────────

const CLUSTER: "devnet" | "mainnet" = "devnet"; // ← change to "mainnet" for production

const RAYDIUM_CPMM_PROGRAM: Record<string, PublicKey> = {
  devnet: new PublicKey("CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW"),
  mainnet: new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
};

// Default AMM config (0.25% swap fee, index 0).
// You can list all configs via `raydium-sdk-v2` or Raydium's REST API.
const AMM_CONFIG: Record<string, PublicKey> = {
  devnet: new PublicKey("9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6"),
  mainnet: new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2"),
};

// Raydium's create-pool fee receiver wallet (fixed per cluster).
const CREATE_POOL_FEE: Record<string, PublicKey> = {
  devnet: new PublicKey("G11FKBRaAkHAKuLCgLM6K6NUc9rTjPAznRCjZifrTQe2"),
  mainnet: new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8"),
};

const targetCluster = process.env.CLUSTER ?? CLUSTER;
if (targetCluster !== "devnet" && targetCluster !== "mainnet") {
  throw new Error('CLUSTER must be either "devnet" or "mainnet".');
}

// ─────────────────────────────────────────────
//  Raydium CPMM PDA seeds (mirrors on-chain source)
// ─────────────────────────────────────────────

const AUTH_SEED = Buffer.from("vault_and_lp_mint_auth_seed");
const POOL_SEED = Buffer.from("pool");
const LP_MINT_SEED = Buffer.from("pool_lp_mint");
const POOL_VAULT_SEED = Buffer.from("pool_vault");
const OBSERVATION_SEED = Buffer.from("observation");

function findRaydiumAuthority(cpmmProgram: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([AUTH_SEED], cpmmProgram);
  return pda;
}

function findPoolState(
  cpmmProgram: PublicKey,
  ammConfig: PublicKey,
  token0Mint: PublicKey,
  token1Mint: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [POOL_SEED, ammConfig.toBuffer(), token0Mint.toBuffer(), token1Mint.toBuffer()],
    cpmmProgram
  );
  return pda;
}

function findLpMint(cpmmProgram: PublicKey, poolState: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [LP_MINT_SEED, poolState.toBuffer()],
    cpmmProgram
  );
  return pda;
}

function findPoolVault(
  cpmmProgram: PublicKey,
  poolState: PublicKey,
  mint: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [POOL_VAULT_SEED, poolState.toBuffer(), mint.toBuffer()],
    cpmmProgram
  );
  return pda;
}

function findObservationState(
  cpmmProgram: PublicKey,
  poolState: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [OBSERVATION_SEED, poolState.toBuffer()],
    cpmmProgram
  );
  return pda;
}

// ─────────────────────────────────────────────
//  Launchpad PDA helpers
// ─────────────────────────────────────────────

const LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn" // ← matches declare_id! in lib.rs
);
// Existing Devnet deployment; this must match Anchor.toml and the frontend.
const DEPLOYED_LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn"
);

function findCurve(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("curve"), mint.toBuffer()],
    DEPLOYED_LAUNCHPAD_PROGRAM_ID
  );
}

function findCurveAuthority(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("curve_authority"), mint.toBuffer()],
    DEPLOYED_LAUNCHPAD_PROGRAM_ID
  );
}

function findCurveTreasury(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), mint.toBuffer()],
    DEPLOYED_LAUNCHPAD_PROGRAM_ID
  );
}

// ─────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────

async function main() {
  const mintArg = process.argv[2];
  if (!mintArg) {
    console.error("Usage: ts-node app/migrate.ts <MINT_PUBKEY>");
    process.exit(1);
  }

  const memecoinMint = new PublicKey(mintArg);

  // --- Provider / program ---
  const walletPath = process.env.SOLANA_WALLET_PATH ?? process.env.ANCHOR_WALLET;
  if (!walletPath) {
    throw new Error("Set SOLANA_WALLET_PATH or ANCHOR_WALLET to a local keeper keypair JSON file.");
  }
  const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))))
  );
  const provider = new anchor.AnchorProvider(
    new Connection(process.env.SOLANA_RPC_URL ?? process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com", "confirmed"),
    wallet,
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const { connection } = provider;

  const idlPath = path.resolve(__dirname, "../target/idl/launchpad_core.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  // The IDL is loaded at runtime, so avoid Anchor's deeply recursive generic
  // inference here. Runtime account and argument validation remains unchanged.
  const program: any = new anchor.Program(idl, provider);

  // --- Launchpad PDAs ---
  const [curve] = findCurve(memecoinMint);
  const [curveAuthority] = findCurveAuthority(memecoinMint);
  const [curveTreasury] = findCurveTreasury(memecoinMint);

  const curveTokenVault = getAssociatedTokenAddressSync(
    memecoinMint,
    curveAuthority,
    true // allowOwnerOffCurve — curveAuthority is a PDA
  );

  const curveAuthorityWsol = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    curveAuthority,
    true
  );

  // --- Raydium setup ---
  const cpmmProgram = RAYDIUM_CPMM_PROGRAM[targetCluster];
  const ammConfig = AMM_CONFIG[targetCluster];
  const createPoolFee = CREATE_POOL_FEE[targetCluster];
  const ammConfigAccount = await connection.getAccountInfo(ammConfig, "confirmed");
  if (!ammConfigAccount || ammConfigAccount.data.length < 44) {
    throw new Error(`Could not read the Raydium ${targetCluster} AMM configuration at ${ammConfig.toBase58()}.`);
  }
  const configuredCreatePoolFee = Number(ammConfigAccount.data.readBigUInt64LE(36));
  const poolFunding = configuredCreatePoolFee + 100_000_000;
  if (!Number.isSafeInteger(poolFunding)) {
    throw new Error("Raydium create-pool fee exceeds JavaScript's safe integer range.");
  }

  // Sort token pair: token0 < token1 by pubkey bytes (Raydium invariant)
  let token0Mint: PublicKey;
  let token1Mint: PublicKey;
  if (memecoinMint.toBuffer().compare(NATIVE_MINT.toBuffer()) < 0) {
    token0Mint = memecoinMint;
    token1Mint = NATIVE_MINT;
  } else {
    token0Mint = NATIVE_MINT;
    token1Mint = memecoinMint;
  }

  const raydiumAuthority = findRaydiumAuthority(cpmmProgram);
  const poolState = findPoolState(cpmmProgram, ammConfig, token0Mint, token1Mint);
  const lpMint = findLpMint(cpmmProgram, poolState);
  const token0Vault = findPoolVault(cpmmProgram, poolState, token0Mint);
  const token1Vault = findPoolVault(cpmmProgram, poolState, token1Mint);
  const observationState = findObservationState(cpmmProgram, poolState);

  // LP token ATA for curveAuthority (Raydium sends LP here, then we burn it)
  const creatorLpToken = getAssociatedTokenAddressSync(
    lpMint,
    curveAuthority,
    true
  );

  console.log("\n── Accounts ───────────────────────────────────────────");
  console.log("cluster              :", targetCluster);
  console.log("memecoin mint        :", memecoinMint.toBase58());
  console.log("curve                :", curve.toBase58());
  console.log("curve_authority      :", curveAuthority.toBase58());
  console.log("curve_treasury       :", curveTreasury.toBase58());
  console.log("curve_token_vault    :", curveTokenVault.toBase58());
  console.log("curve_authority_wsol :", curveAuthorityWsol.toBase58());
  console.log("token_0_mint         :", token0Mint.toBase58());
  console.log("token_1_mint         :", token1Mint.toBase58());
  console.log("amm_config           :", ammConfig.toBase58());
  console.log("raydium_authority    :", raydiumAuthority.toBase58());
  console.log("pool_state           :", poolState.toBase58());
  console.log("lp_mint              :", lpMint.toBase58());
  console.log("creator_lp_token     :", creatorLpToken.toBase58());
  console.log("token_0_vault        :", token0Vault.toBase58());
  console.log("token_1_vault        :", token1Vault.toBase58());
  console.log("create_pool_fee      :", createPoolFee.toBase58());
  console.log("pool_funding         :", poolFunding, "lamports (from curve fee surplus)");
  console.log("observation_state    :", observationState.toBase58());
  console.log("raydium_cpmm_program :", cpmmProgram.toBase58());
  console.log("───────────────────────────────────────────────────────\n");

  const tx = await program.methods
    .markMigrated(new anchor.BN(poolFunding))
    .accounts({
      curve,
      payer: wallet.publicKey,
      curveAuthority,
      curveTreasury,
      curveTokenVault,
      memecoinMint,
      wsolMint: NATIVE_MINT,
      curveAuthorityWsol,
      ammConfig,
      raydiumAuthority,
      poolState,
      lpMint,
      creatorLpToken,
      token0Vault,
      token1Vault,
      createPoolFee,
      observationState,
      raydiumCpmmProgram: cpmmProgram,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc({ commitment: "confirmed" });

  console.log("✅ Migration successful!");
  console.log("   tx signature :", tx);
  console.log("   pool_state   :", poolState.toBase58());
  console.log("   lp_mint      :", lpMint.toBase58());
  console.log(
    "   explorer     :",
    targetCluster === "mainnet"
      ? `https://solscan.io/tx/${tx}`
      : `https://solscan.io/tx/${tx}?cluster=devnet`
  );
}

main().catch((err) => {
  console.error("\n❌ Migration failed:", err);
  process.exit(1);
});

