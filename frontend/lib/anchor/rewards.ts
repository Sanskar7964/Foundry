import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import rewardVaultIdl from "./idl/reward_vault.json";
import { LAUNCHPAD_TOKEN_MINT, REWARD_VAULT_PROGRAM_ID } from "./constants";
import { rewardPoolPda, rewardVaultSolPda, userStakePda } from "./pdas";

const ACC_PRECISION = 1_000_000_000_000n;

function asBigInt(value: unknown): bigint {
  return BigInt((value as { toString(): string }).toString());
}

function readProgram(connection: Connection) {
  return new anchor.Program(rewardVaultIdl as unknown as anchor.Idl, { connection } as anchor.Provider);
}

export interface RewardVaultState {
  configured: boolean;
  totalStaked: bigint;
  totalFeesCollected: bigint;
  rewardVaultBalance: bigint;
  userStaked: bigint;
  pendingReward: bigint;
}

/** Finds the single token account owned by the pool PDA that holds staked tokens. */
export async function findStakeVault(connection: Connection, pool: PublicKey): Promise<PublicKey> {
  const accounts = await connection.getTokenAccountsByOwner(pool, { mint: LAUNCHPAD_TOKEN_MINT }, "confirmed");
  if (accounts.value.length !== 1) {
    throw new Error(accounts.value.length === 0 ? "The reward pool has no stake vault. Initialize the pool first." : "The reward pool has multiple stake vaults; resolve the pool configuration before staking.");
  }
  return accounts.value[0].pubkey;
}

export async function fetchRewardVaultState(connection: Connection, owner?: PublicKey | null): Promise<RewardVaultState> {
  const [pool] = rewardPoolPda(LAUNCHPAD_TOKEN_MINT);
  const [vaultSol] = rewardVaultSolPda(LAUNCHPAD_TOKEN_MINT);
  if (!(await connection.getAccountInfo(pool, "confirmed"))) {
    return { configured: false, totalStaked: 0n, totalFeesCollected: 0n, rewardVaultBalance: 0n, userStaked: 0n, pendingReward: 0n };
  }
  const program = readProgram(connection);
  const poolAccount = await (program.account as any).pool.fetch(pool);
  const totalStaked = asBigInt(poolAccount.totalStaked ?? poolAccount.total_staked);
  const accRewardPerShare = asBigInt(poolAccount.accRewardPerShare ?? poolAccount.acc_reward_per_share);
  const totalFeesCollected = asBigInt(poolAccount.totalFeesCollected ?? poolAccount.total_fees_collected);
  const [rewardVaultBalance, user] = await Promise.all([
    connection.getBalance(vaultSol, "confirmed").then(BigInt),
    owner ? (async () => {
      const [userStake] = userStakePda(pool, owner);
      if (!(await connection.getAccountInfo(userStake, "confirmed"))) return null;
      return (program.account as any).userStake.fetch(userStake);
    })() : Promise.resolve(null),
  ]);
  const userStaked = user ? asBigInt(user.amount) : 0n;
  const rewardDebt = user ? asBigInt(user.rewardDebt ?? user.reward_debt) : 0n;
  const accrued = userStaked * accRewardPerShare / ACC_PRECISION;
  return { configured: true, totalStaked, totalFeesCollected, rewardVaultBalance, userStaked, pendingReward: accrued > rewardDebt ? accrued - rewardDebt : 0n };
}

export function assertRewardVaultProgram(): void {
  if (REWARD_VAULT_PROGRAM_ID.equals(PublicKey.default)) throw new Error("Set the deployed reward-vault program ID before staking.");
}
