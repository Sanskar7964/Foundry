import { PublicKey } from "@solana/web3.js";
import {
  LAUNCHPAD_CORE_PROGRAM_ID,
  REWARD_VAULT_PROGRAM_ID,
  MERKLE_DISTRIBUTOR_PROGRAM_ID,
} from "./constants";

// --- launchpad-core PDAs (seeds must match programs/launchpad-core/src/lib.rs) ---

export function curvePda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.toBuffer()], LAUNCHPAD_CORE_PROGRAM_ID);
}

export function curveAuthorityPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("curve_authority"), mint.toBuffer()],
    LAUNCHPAD_CORE_PROGRAM_ID
  );
}

export function airdropAuthorityPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("airdrop_authority"), mint.toBuffer()],
    LAUNCHPAD_CORE_PROGRAM_ID
  );
}

export function curveTreasuryPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("treasury"), mint.toBuffer()], LAUNCHPAD_CORE_PROGRAM_ID);
}

export function launchMetadataPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), mint.toBuffer()], LAUNCHPAD_CORE_PROGRAM_ID);
}

// --- reward-vault PDAs ---

export function rewardPoolPda(stakeMint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), stakeMint.toBuffer()], REWARD_VAULT_PROGRAM_ID);
}

export function rewardVaultSolPda(stakeMint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault_sol"), stakeMint.toBuffer()], REWARD_VAULT_PROGRAM_ID);
}

export function userStakePda(pool: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user"), pool.toBuffer(), owner.toBuffer()],
    REWARD_VAULT_PROGRAM_ID
  );
}

// --- merkle-distributor PDAs ---

export function keeperConfigPda() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("keeper_config")],
    MERKLE_DISTRIBUTOR_PROGRAM_ID
  );
}

export function distributorPda(mint: PublicKey, epoch: number) {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(BigInt(epoch));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("distributor"), mint.toBuffer(), epochBuf],
    MERKLE_DISTRIBUTOR_PROGRAM_ID
  );
}

export function claimReceiptPda(distributor: PublicKey, claimant: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), distributor.toBuffer(), claimant.toBuffer()],
    MERKLE_DISTRIBUTOR_PROGRAM_ID
  );
}
