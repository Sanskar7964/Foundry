"use client";

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { keccak_256 } from "@noble/hashes/sha3";

import launchpadCoreIdl from "./idl/launchpad_core.json";
import rewardVaultIdl from "./idl/reward_vault.json";
import merkleDistributorIdl from "./idl/merkle_distributor.json";
import {
  LAUNCHPAD_CORE_PROGRAM_ID,
  REWARD_VAULT_PROGRAM_ID,
  MERKLE_DISTRIBUTOR_PROGRAM_ID,
  LAUNCHPAD_TOKEN_MINT,
} from "./constants";
import {
  airdropAuthorityPda,
  curveAuthorityPda,
  curvePda,
  curveTreasuryPda,
  launchMetadataPda,
  rewardPoolPda,
  rewardVaultSolPda,
  userStakePda,
  distributorPda,
  claimReceiptPda,
  keeperConfigPda,
} from "./pdas";
import { findStakeVault } from "./rewards";

// The live Devnet program must be upgraded before the additional CreateLaunch
// account is used. Keeping this opt-in prevents a new frontend build from
// breaking the already-deployed program's account ordering.
export const LAUNCH_METADATA_ENABLED = process.env.NEXT_PUBLIC_LAUNCH_METADATA_ENABLED === "true";

/**
 * NOTE: the IDL JSON files under ./idl are placeholders (empty instruction
 * lists) until you run `anchor build` in the workspace root and copy the
 * generated target/idl/*.json files over them. Until then, Program() below
 * will construct fine but any .methods.xxx() call will throw "method does
 * not exist" — that's expected and goes away once the real IDL is in place.
 */

function getProvider(connection: Connection, wallet: WalletContextState): AnchorProvider {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error("Wallet not connected");
  }
  return new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
}

export function getLaunchpadCoreProgram(connection: Connection, wallet: WalletContextState) {
  const provider = getProvider(connection, wallet);
  // Anchor 0.30+: Program(idl, provider) — the program ID is read from the
  // IDL's own `address` field (set from LAUNCHPAD_CORE_PROGRAM_ID once you
  // copy over the real generated IDL after `anchor build`).
  const program = new Program(launchpadCoreIdl as unknown as anchor.Idl, provider);
  if (!program.programId.equals(LAUNCHPAD_CORE_PROGRAM_ID)) {
    throw new Error(
      `Launchpad program ID mismatch: IDL has ${program.programId.toBase58()}, but NEXT_PUBLIC_LAUNCHPAD_CORE_PROGRAM_ID has ${LAUNCHPAD_CORE_PROGRAM_ID.toBase58()}.`
    );
  }
  return program;
}

export function getRewardVaultProgram(connection: Connection, wallet: WalletContextState) {
  const provider = getProvider(connection, wallet);
  return new Program(rewardVaultIdl as unknown as anchor.Idl, provider);
}

export function getMerkleDistributorProgram(connection: Connection, wallet: WalletContextState) {
  const provider = getProvider(connection, wallet);
  return new Program(merkleDistributorIdl as unknown as anchor.Idl, provider);
}

// ---- launchpad-core calls ----

export async function createLaunch(
  connection: Connection,
  wallet: WalletContextState,
  name: string,
  symbol: string,
  uri: string,
  airdropBps: number,
  onStatus?: (status: string) => void
) {
  if (!Number.isInteger(airdropBps) || airdropBps < 100 || airdropBps > 500) {
    throw new Error("Holder airdrop reserve must be between 1% and 5%.");
  }

  const creator = wallet.publicKey;
  if (!creator) throw new Error("Wallet not connected");

  const program = getLaunchpadCoreProgram(connection, wallet);
  const mint = Keypair.generate();
  const [curve] = curvePda(mint.publicKey);
  const [curveAuthority] = curveAuthorityPda(mint.publicKey);
  const [airdropAuthority] = airdropAuthorityPda(mint.publicKey);
  const [curveTreasury] = curveTreasuryPda(mint.publicKey);
  const curveTokenVault = await getAssociatedTokenAddress(mint.publicKey, curveAuthority, true);
  const airdropVault = await getAssociatedTokenAddress(mint.publicKey, airdropAuthority, true);

  onStatus?.("Building transaction…");
  const transaction = await program.methods
    .createLaunch(name, symbol, uri, airdropBps)
    .accounts({
      creator,
      mint: mint.publicKey,
      curve,
      curveAuthority,
      airdropAuthority,
      curveTreasury,
      curveTokenVault,
      airdropVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .signers([mint])
    .transaction();

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = creator;
  transaction.recentBlockhash = blockhash;
  transaction.partialSign(mint);

  onStatus?.("Approve the transaction in Phantom…");
  const signedTransaction = await withTimeout(
    wallet.signTransaction!(transaction),
    90_000,
    "Wallet approval timed out. Open Phantom, ensure it is unlocked and on Devnet, then try again."
  );

  onStatus?.("Broadcasting transaction…");
  const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
    preflightCommitment: "confirmed",
  });

  onStatus?.("Confirming on Devnet…");
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return { signature, mint: mint.publicKey, curve, airdropVault };
}

/** Creates or backfills the display record for a launch. Only its creator may do this. */
export async function setLaunchMetadata(
  connection: Connection,
  wallet: WalletContextState,
  mint: PublicKey,
  name: string,
  symbol: string,
  uri: string,
  onStatus?: (status: string) => void
) {
  if (!LAUNCH_METADATA_ENABLED) {
    throw new Error("Coin metadata is not enabled on the deployed program yet.");
  }
  if (!name || !symbol || !uri) throw new Error("Name, symbol, and metadata URI are required.");
  if (name.length > 32 || symbol.length > 10 || uri.length > 200) {
    throw new Error("Name, symbol, or metadata URI is too long.");
  }
  const creator = wallet.publicKey;
  if (!creator) throw new Error("Wallet not connected");

  const program = getLaunchpadCoreProgram(connection, wallet);
  const [curve] = curvePda(mint);
  const [metadata] = launchMetadataPda(mint);
  onStatus?.("Building metadata transaction…");
  const transaction = await program.methods
    .setLaunchMetadata(name, symbol, uri)
    .accounts({ creator, curve, metadata, systemProgram: SystemProgram.programId } as any)
    .transaction();
  return signSendAndConfirm(connection, wallet, transaction, onStatus);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function signSendAndConfirm(
  connection: Connection,
  wallet: WalletContextState,
  transaction: Transaction,
  onStatus?: (status: string) => void
) {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = blockhash;

  onStatus?.("Approve the transaction in Phantom…");
  const signed = await withTimeout(
    wallet.signTransaction(transaction),
    90_000,
    "Wallet approval timed out. Open Phantom, ensure it is unlocked and on Devnet, then try again."
  );
  onStatus?.("Broadcasting transaction…");
  const signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
  onStatus?.("Confirming on Devnet…");
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}

/** Funds a previously created Merkle epoch from the immutable launch reserve. */
export async function fundDistributor(
  connection: Connection,
  wallet: WalletContextState,
  mint: PublicKey,
  distributor: PublicKey,
  epochVault: PublicKey,
  amount: number
) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Funding amount must be a positive integer.");
  if (!wallet.publicKey) throw new Error("Wallet not connected");

  const program = getLaunchpadCoreProgram(connection, wallet);
  const [curve] = curvePda(mint);
  const [airdropAuthority] = airdropAuthorityPda(mint);
  const airdropVault = await getAssociatedTokenAddress(mint, airdropAuthority, true);

  return program.methods
    .fundDistributor(new BN(amount))
    .accounts({
      creator: wallet.publicKey,
      curve,
      airdropAuthority,
      airdropVault,
      distributor,
      epochVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();
}

export async function buyTokens(
  connection: Connection,
  wallet: WalletContextState,
  mint: PublicKey,
  solInLamports: number,
  minTokensOut: number,
  onStatus?: (status: string) => void
) {
  const program = getLaunchpadCoreProgram(connection, wallet);
  const [curve] = curvePda(mint);
  const [curveAuthority] = curveAuthorityPda(mint);
  const [curveTreasury] = curveTreasuryPda(mint);
  const curveTokenVault = await getAssociatedTokenAddress(mint, curveAuthority, true);
  const buyerTokenAccount = await getAssociatedTokenAddress(mint, wallet.publicKey!);
  const [rewardPool] = rewardPoolPda(LAUNCHPAD_TOKEN_MINT);
  const [rewardVaultSol] = rewardVaultSolPda(LAUNCHPAD_TOKEN_MINT);
  const rewardVaultProgram = getRewardVaultProgram(connection, wallet);

  onStatus?.("Building buy transaction…");
  // Launches created before curve treasuries were initialized need this
  // permissionless one-time setup. Keeping it in this transaction gives the
  // buyer a single approval and makes the first buy atomic.
  const treasuryInfo = await connection.getAccountInfo(curveTreasury, "confirmed");
  const initializeTreasuryInstruction = treasuryInfo
    ? undefined
    : await program.methods
        .initializeCurveTreasury()
        .accounts({
          payer: wallet.publicKey,
          curve,
          curveTreasury,
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction();
  // The staker fee is much smaller than rent, so its destination must be
  // rent-funded before the first trade. This also repairs the existing pool.
  const rewardVaultInfo = await connection.getAccountInfo(rewardVaultSol, "confirmed");
  const initializeRewardVaultInstruction = rewardVaultInfo
    ? undefined
    : await rewardVaultProgram.methods
        .initializeSolVault()
        .accounts({
          payer: wallet.publicKey,
          pool: rewardPool,
          vaultSol: rewardVaultSol,
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction();
  const buyInstruction = await program.methods
    .buy(new BN(solInLamports), new BN(minTokensOut))
    .accounts({
      buyer: wallet.publicKey,
      curve,
      curveAuthority,
      curveTreasury,
      curveTokenVault,
      buyerTokenAccount,
      rewardVaultPool: rewardPool,
      rewardVaultSol,
      rewardVaultProgram: REWARD_VAULT_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();

  // This idempotent instruction creates the ATA only for a first-time buyer;
  // it and the buy execute atomically under one Phantom approval.
  const transaction = new Transaction();
  if (initializeTreasuryInstruction) transaction.add(initializeTreasuryInstruction);
  if (initializeRewardVaultInstruction) transaction.add(initializeRewardVaultInstruction);
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey!, buyerTokenAccount, wallet.publicKey!, mint),
    buyInstruction
  );
  return signSendAndConfirm(connection, wallet, transaction, onStatus);
}

export async function sellTokens(
  connection: Connection,
  wallet: WalletContextState,
  mint: PublicKey,
  tokensIn: number,
  minSolOut: number,
  onStatus?: (status: string) => void
) {
  const program = getLaunchpadCoreProgram(connection, wallet);
  const [curve] = curvePda(mint);
  const [curveAuthority] = curveAuthorityPda(mint);
  const [curveTreasury] = curveTreasuryPda(mint);
  const curveTokenVault = await getAssociatedTokenAddress(mint, curveAuthority, true);
  const buyerTokenAccount = await getAssociatedTokenAddress(mint, wallet.publicKey!);
  const [rewardPool] = rewardPoolPda(LAUNCHPAD_TOKEN_MINT);
  const [rewardVaultSol] = rewardVaultSolPda(LAUNCHPAD_TOKEN_MINT);

  onStatus?.("Building sell transaction…");
  const sellInstruction = await program.methods
    .sell(new BN(tokensIn), new BN(minSolOut))
    .accounts({
      buyer: wallet.publicKey,
      curve,
      curveAuthority,
      curveTreasury,
      curveTokenVault,
      buyerTokenAccount,
      rewardVaultPool: rewardPool,
      rewardVaultSol,
      rewardVaultProgram: REWARD_VAULT_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
  return signSendAndConfirm(connection, wallet, new Transaction().add(sellInstruction), onStatus);
}

const RAYDIUM_CPMM_DEVNET_PROGRAM_ID = new PublicKey("CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW");
// Raydium's official CPMM Devnet config / create-pool fee receiver. These
// must belong to CPMDWB..., not the separate DRaycp... deployment.
const RAYDIUM_DEVNET_AMM_CONFIG = new PublicKey("9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6");
const RAYDIUM_DEVNET_CREATE_POOL_FEE = new PublicKey("G11FKBRaAkHAKuLCgLM6K6NUc9rTjPAznRCjZifrTQe2");
const RAYDIUM_RENT_BUFFER_LAMPORTS = 100_000_000; // returned if Raydium does not spend it

function raydiumPda(seeds: Buffer[]) {
  return PublicKey.findProgramAddressSync(seeds, RAYDIUM_CPMM_DEVNET_PROGRAM_ID)[0];
}

/** Deterministic Raydium Devnet CPMM pool address for a migrated launch. */
export function raydiumPoolForLaunch(mint: PublicKey) {
  const [token0Mint, token1Mint] = Buffer.compare(mint.toBuffer(), NATIVE_MINT.toBuffer()) < 0
    ? [mint, NATIVE_MINT]
    : [NATIVE_MINT, mint];
  return raydiumPda([
    Buffer.from("pool"), RAYDIUM_DEVNET_AMM_CONFIG.toBuffer(), token0Mint.toBuffer(), token1Mint.toBuffer(),
  ]);
}

/**
 * Migrates a ready curve to a Devnet Raydium CPMM pool. Any connected wallet
 * may submit it; Raydium setup is funded from the curve's fee surplus.
 */
export async function migrateLaunch(
  connection: Connection,
  wallet: WalletContextState,
  mint: PublicKey,
  onStatus?: (status: string) => void
) {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const program = getLaunchpadCoreProgram(connection, wallet);
  const [curve] = curvePda(mint);
  const [curveAuthority] = curveAuthorityPda(mint);
  const [curveTreasury] = curveTreasuryPda(mint);
  const curveTokenVault = await getAssociatedTokenAddress(mint, curveAuthority, true);
  const curveAuthorityWsol = await getAssociatedTokenAddress(NATIVE_MINT, curveAuthority, true);

  const [token0Mint, token1Mint] = Buffer.compare(mint.toBuffer(), NATIVE_MINT.toBuffer()) < 0
    ? [mint, NATIVE_MINT]
    : [NATIVE_MINT, mint];
  const raydiumAuthority = raydiumPda([Buffer.from("vault_and_lp_mint_auth_seed")]);
  const poolState = raydiumPoolForLaunch(mint);
  const lpMint = raydiumPda([Buffer.from("pool_lp_mint"), poolState.toBuffer()]);
  const creatorLpToken = await getAssociatedTokenAddress(lpMint, curveAuthority, true);
  const token0Vault = raydiumPda([Buffer.from("pool_vault"), poolState.toBuffer(), token0Mint.toBuffer()]);
  const token1Vault = raydiumPda([Buffer.from("pool_vault"), poolState.toBuffer(), token1Mint.toBuffer()]);
  const observationState = raydiumPda([Buffer.from("observation"), poolState.toBuffer()]);

  const configInfo = await connection.getAccountInfo(RAYDIUM_DEVNET_AMM_CONFIG, "confirmed");
  if (!configInfo || configInfo.data.length < 44) {
    throw new Error("Could not read the Raydium Devnet AMM configuration.");
  }
  // AmmConfig: 8-byte discriminator, bump, disabled flag, u16 index, then
  // trade/protocol/fund/create-pool fee u64 values. This temporary budget
  // comes from the curve's accrued fee surplus and unused funds return there.
  const createPoolFee = Number(configInfo.data.readBigUInt64LE(36));
  const poolFunding = createPoolFee + RAYDIUM_RENT_BUFFER_LAMPORTS;

  onStatus?.("Building Raydium migration transaction…");
  const migrateInstruction = await program.methods
    .markMigrated(new BN(poolFunding))
    .accounts({
      curve,
      payer: wallet.publicKey,
      curveAuthority,
      curveTreasury,
      curveTokenVault,
      memecoinMint: mint,
      wsolMint: NATIVE_MINT,
      curveAuthorityWsol,
      ammConfig: RAYDIUM_DEVNET_AMM_CONFIG,
      raydiumAuthority,
      poolState,
      lpMint,
      creatorLpToken,
      token0Vault,
      token1Vault,
      createPoolFee: RAYDIUM_DEVNET_CREATE_POOL_FEE,
      observationState,
      raydiumCpmmProgram: RAYDIUM_CPMM_DEVNET_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .instruction();

  // The LP mint does not exist until Raydium initializes the pool. Its
  // initialize CPI creates this ATA, then launchpad-core burns the LP tokens.
  const signature = await signSendAndConfirm(connection, wallet, new Transaction().add(migrateInstruction), onStatus);
  return { signature, poolState };
}

// ---- reward-vault calls ----

export async function stakeLaunchpadTokens(connection: Connection, wallet: WalletContextState, amount: number) {
  const program = getRewardVaultProgram(connection, wallet);
  const [pool] = rewardPoolPda(LAUNCHPAD_TOKEN_MINT);
  const [userStake] = userStakePda(pool, wallet.publicKey!);
  const userTokenAccount = await getAssociatedTokenAddress(LAUNCHPAD_TOKEN_MINT, wallet.publicKey!);
  const stakeVault = await findStakeVault(connection, pool);
  const [vaultSol] = rewardVaultSolPda(LAUNCHPAD_TOKEN_MINT);

  return program.methods
    .stake(new BN(amount))
    .accounts({
      owner: wallet.publicKey,
      pool,
      userStake,
      userTokenAccount,
      stakeVault,
      vaultSol,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
}

export async function unstakeLaunchpadTokens(connection: Connection, wallet: WalletContextState, amount: number) {
  const program = getRewardVaultProgram(connection, wallet);
  const [pool] = rewardPoolPda(LAUNCHPAD_TOKEN_MINT);
  const [userStake] = userStakePda(pool, wallet.publicKey!);
  const userTokenAccount = await getAssociatedTokenAddress(LAUNCHPAD_TOKEN_MINT, wallet.publicKey!);
  const stakeVault = await findStakeVault(connection, pool);
  const [vaultSol] = rewardVaultSolPda(LAUNCHPAD_TOKEN_MINT);

  return program.methods
    .unstake(new BN(amount))
    .accounts({
      owner: wallet.publicKey,
      pool,
      userStake,
      userTokenAccount,
      stakeVault,
      vaultSol,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
}

export async function claimStakingRewards(connection: Connection, wallet: WalletContextState) {
  const program = getRewardVaultProgram(connection, wallet);
  const [pool] = rewardPoolPda(LAUNCHPAD_TOKEN_MINT);
  const [userStake] = userStakePda(pool, wallet.publicKey!);
  const [vaultSol] = rewardVaultSolPda(LAUNCHPAD_TOKEN_MINT);

  return program.methods
    .claim()
    .accounts({
      owner: wallet.publicKey,
      pool,
      userStake,
      vaultSol,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
}

// ---- merkle-distributor calls ----

/** Reads the globally configured Merkle keeper. `null` means it has not yet been initialized. */
export async function getMerkleKeeper(
  connection: Connection,
  wallet: WalletContextState
): Promise<{ config: PublicKey; authority: PublicKey | null }> {
  const [config] = keeperConfigPda();
  const info = await connection.getAccountInfo(config, "confirmed");
  if (!info) return { config, authority: null };

  const program = getMerkleDistributorProgram(connection, wallet);
  const keeperConfig = await (program.account as any).keeperConfig.fetch(config);
  return { config, authority: keeperConfig.authority as PublicKey };
}

/** One-time Devnet setup. The connected wallet becomes the global keeper. */
export async function initializeMerkleKeeper(
  connection: Connection,
  wallet: WalletContextState
) {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const [config] = keeperConfigPda();
  const program = getMerkleDistributorProgram(connection, wallet);
  return program.methods
    .initializeKeeper(wallet.publicKey)
    .accounts({ payer: wallet.publicKey, config, systemProgram: SystemProgram.programId } as any)
    .rpc();
}

/** Creates a one-holder epoch. Its Merkle proof is deliberately empty. */
export async function createSingleLeafDistributor(
  connection: Connection,
  wallet: WalletContextState,
  mint: PublicKey,
  epoch: number,
  recipient: PublicKey,
  amountRaw: string
) {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Epoch must be a non-negative integer.");
  if (!/^\d+$/.test(amountRaw)) throw new Error("Amount must be a positive raw token amount.");
  const amount = new BN(amountRaw);
  if (amount.isZero()) throw new Error("Amount must be a positive raw token amount.");
  const amountBytes = amount.toArrayLike(Buffer, "le", 8);
  const root = Buffer.from(keccak_256(Buffer.concat([recipient.toBuffer(), amountBytes])));
  const [keeperConfig] = keeperConfigPda();
  const [distributor] = distributorPda(mint, epoch);
  const epochVault = await getAssociatedTokenAddress(mint, distributor, true);
  const program = getMerkleDistributorProgram(connection, wallet);

  const signature = await program.methods
    .createDistributor(new BN(epoch), Array.from(root), amount)
    .accounts({
      authority: wallet.publicKey,
      keeperConfig,
      mint,
      distributor,
      epochVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();

  return { signature, distributor, epochVault, root: root.toString("hex") };
}

export async function claimHolderAirdrop(
  connection: Connection,
  wallet: WalletContextState,
  mint: PublicKey,
  epoch: number,
  amountRaw: string,
  proof: Buffer[]
) {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  if (!/^\d+$/.test(amountRaw) || amountRaw === "0") throw new Error("Claim amount must be a positive raw token amount.");
  const program = getMerkleDistributorProgram(connection, wallet);
  const [distributor] = distributorPda(mint, epoch);
  const [receipt] = claimReceiptPda(distributor, wallet.publicKey!);
  const epochVault = await getAssociatedTokenAddress(mint, distributor, true);
  const claimantTokenAccount = await getAssociatedTokenAddress(mint, wallet.publicKey!);
  const claimInstruction = await program.methods
    .claim(new BN(epoch), new BN(amountRaw), proof)
    .accounts({
      claimant: wallet.publicKey,
      distributor,
      epochVault,
      claimantTokenAccount,
      receipt,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, claimantTokenAccount, wallet.publicKey, mint),
    claimInstruction
  );
  return signSendAndConfirm(connection, wallet, transaction);
}
