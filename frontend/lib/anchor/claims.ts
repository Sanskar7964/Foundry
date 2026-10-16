import { Connection, PublicKey } from "@solana/web3.js";
import { AIRDROP_CLAIMS_URL } from "./constants";
import { claimReceiptPda, distributorPda } from "./pdas";

export interface PublishedClaim {
  claimant: string;
  mint: string;
  epoch: number;
  amount: string;
  proof: string[];
  name?: string;
  symbol?: string;
}

export interface ClaimWithStatus extends PublishedClaim {
  claimed: boolean;
  available: boolean;
}

function parseClaim(value: unknown): PublishedClaim | null {
  if (!value || typeof value !== "object") return null;
  const claim = value as Record<string, unknown>;
  if (typeof claim.claimant !== "string" || typeof claim.mint !== "string" || typeof claim.epoch !== "number" || !Number.isSafeInteger(claim.epoch) || claim.epoch < 0 || typeof claim.amount !== "string" || !/^\d+$/.test(claim.amount) || !Array.isArray(claim.proof) || !claim.proof.every((node) => typeof node === "string" && /^(?:[0-9a-fA-F]{2}){32}$/.test(node))) return null;
  try { new PublicKey(claim.claimant); new PublicKey(claim.mint); } catch { return null; }
  return { claimant: claim.claimant, mint: claim.mint, epoch: claim.epoch, amount: claim.amount, proof: claim.proof as string[], name: typeof claim.name === "string" ? claim.name : undefined, symbol: typeof claim.symbol === "string" ? claim.symbol : undefined };
}

/**
 * Reads the keeper-published proof manifest. Expected JSON is either a claims
 * array or `{ "claims": [...] }`; each claim must include claimant, mint,
 * epoch, amount (raw units), and proof (32-byte hex strings).
 */
export async function fetchWalletClaims(connection: Connection, wallet: PublicKey): Promise<ClaimWithStatus[]> {
  if (!AIRDROP_CLAIMS_URL) return [];
  const response = await fetch(AIRDROP_CLAIMS_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load airdrop proofs (${response.status}).`);
  const payload: unknown = await response.json();
  const values = Array.isArray(payload) ? payload : (payload && typeof payload === "object" && Array.isArray((payload as { claims?: unknown }).claims) ? (payload as { claims: unknown[] }).claims : []);
  const claims = values.map(parseClaim).filter((claim): claim is PublishedClaim => claim !== null).filter((claim) => claim.claimant === wallet.toBase58());
  return Promise.all(claims.map(async (claim) => {
    const mint = new PublicKey(claim.mint);
    const [distributor] = distributorPda(mint, claim.epoch);
    const [receipt] = claimReceiptPda(distributor, wallet);
    const [distributorInfo, receiptInfo] = await Promise.all([
      connection.getAccountInfo(distributor, "confirmed"),
      connection.getAccountInfo(receipt, "confirmed"),
    ]);
    return { ...claim, available: distributorInfo !== null, claimed: receiptInfo !== null };
  }));
}
