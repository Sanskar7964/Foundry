import { PublicKey, SystemProgram } from "@solana/web3.js";

// Replace these after `anchor deploy` to devnet — `anchor keys list` prints
// the real addresses. Also update declare_id!() in each program's lib.rs and
// Anchor.toml to match before you build/deploy.
export const CLUSTER = (process.env.NEXT_PUBLIC_CLUSTER ?? "devnet") as "devnet" | "mainnet-beta" | "localnet";

export const RPC_ENDPOINT =
  process.env.NEXT_PUBLIC_RPC_URL ??
  (CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");

export const LAUNCHPAD_CORE_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_LAUNCHPAD_CORE_PROGRAM_ID ?? "HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn"
);
export const REWARD_VAULT_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_REWARD_VAULT_PROGRAM_ID ?? "3xUJqsjCQBfvUhEvz5cd16SSAwLdQUFGijoh3X5pLYPZ"
);
export const MERKLE_DISTRIBUTOR_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_MERKLE_DISTRIBUTOR_PROGRAM_ID ?? "GtpFjU1NZM8NvE2UYfNxszmTL2SW2xU6z4318by8rYC7"
);

// The LAUNCHPAD governance/fee-share token's mint (what people stake in
// reward-vault to earn 25% of platform fees). Set after you mint it — this
// falls back to the System Program ID (all-zero-equivalent, definitely not a
// real mint) purely so the app has a syntactically valid PublicKey pre-launch.
export const LAUNCHPAD_TOKEN_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_LAUNCHPAD_TOKEN_MINT ?? SystemProgram.programId.toBase58()
);

export const TRADE_FEE_BPS = 100; // must match launchpad-core's TRADE_FEE_BPS
export const FEE_SHARE_TO_STAKERS_BPS = 2500; // 25%

// A public JSON document published by the airdrop keeper after every Merkle
// epoch. It contains proofs and is filtered client-side by claimant wallet.
// Defaults to the versioned public manifest so Devnet works without an extra
// environment variable. Deployments can override this with an IPFS/API URL.
export const AIRDROP_CLAIMS_URL = process.env.NEXT_PUBLIC_AIRDROP_CLAIMS_URL?.trim() || "/airdrop-claims.json";
