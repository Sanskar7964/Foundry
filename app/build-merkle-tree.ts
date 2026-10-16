/**
 * Off-chain "keeper" piece of the holder-airdrop loop.
 *
 * Flow per epoch (e.g. daily):
 *   1. Snapshot every token account for a given mint (via getProgramAccounts
 *      filtered by mint, or a Helius/Shyft webhook feed for cheaper reads).
 *   2. Decide each holder's entitlement for this epoch's slice of the
 *      airdrop_bps reserve (simplest: pro-rata by balance; better: weight by
 *      balance * time-held to resist wallet-splitting/sybil farming).
 *   3. Build a Merkle tree where each leaf = keccak256(walletPubkey || amount).
 *   4. Call merkle_distributor.create_distributor(epoch, root, totalAmount)
 *      on-chain with just the 32-byte root.
 *   5. Publish the full {wallet, amount, proof}[] list off-chain (e.g. to
 *      Arweave/IPFS + your frontend's API) so every holder can fetch their
 *      own proof and call claim().
 *
 * This script only does steps 2-3-and-serializing-for-4. Wire the RPC
 * snapshot and the on-chain call into your keeper cron separately.
 */

import keccak256 from "keccak256";
import { MerkleTree } from "merkletreejs";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";

interface HolderBalance {
  wallet: string;
  balance: bigint; // raw token amount, smallest unit
}

interface Entitlement {
  wallet: string;
  amount: bigint;
}

function computeEntitlements(holders: HolderBalance[], epochPoolAmount: bigint): Entitlement[] {
  const totalBalance = holders.reduce((sum, h) => sum + h.balance, BigInt(0));
  if (totalBalance === BigInt(0)) return [];

  return holders
    .map((h) => ({
      wallet: h.wallet,
      // pro-rata by balance; swap in balance * hoursHeld for sybil resistance
      amount: (h.balance * epochPoolAmount) / totalBalance,
    }))
    .filter((e) => e.amount > BigInt(0));
}

function leafFor(wallet: string, amount: bigint): Buffer {
  const walletBytes = new PublicKey(wallet).toBytes();
  const amountBytes = Buffer.alloc(8);
  amountBytes.writeBigUInt64LE(amount);
  return keccak256(Buffer.concat([Buffer.from(walletBytes), amountBytes]));
}

function buildTree(entitlements: Entitlement[]) {
  const leaves = entitlements.map((e) => leafFor(e.wallet, e.amount));
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = tree.getHexRoot();

  const proofs = entitlements.map((e, i) => ({
    wallet: e.wallet,
    amount: e.amount.toString(),
    proof: tree.getHexProof(leaves[i]),
  }));

  return { root, proofs, totalAmount: entitlements.reduce((s, e) => s + e.amount, BigInt(0)) };
}

// --- example usage with mock data; replace with a real RPC snapshot ---
function main() {
  const mockHolders: HolderBalance[] = [
    { wallet: "11111111111111111111111111111111", balance: BigInt(1_000_000) },
    // ... one entry per current holder from your snapshot
  ];

  const epochPoolAmount = BigInt(10_000_000); // this epoch's slice of the 1-5% reserve
  const entitlements = computeEntitlements(mockHolders, epochPoolAmount);
  const { root, proofs, totalAmount } = buildTree(entitlements);

  console.log("root:", root);
  console.log("totalAmount:", totalAmount.toString());

  fs.writeFileSync(
    "epoch-proofs.json",
    JSON.stringify({ root, totalAmount: totalAmount.toString(), proofs }, null, 2)
  );
  console.log(`Wrote ${proofs.length} proofs to epoch-proofs.json`);
  console.log("Next: call merkle_distributor.create_distributor(epoch, root, totalAmount) on-chain,");
  console.log("then publish epoch-proofs.json somewhere holders' wallets can fetch their own proof.");
}

main();
