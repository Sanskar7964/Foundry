import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddress } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { CLUSTER } from "@/lib/anchor/constants";

const MAINNET_API = "https://api-v3.raydium.io";
const MAINNET_SWAP = "https://transaction-v1.raydium.io";
const DEVNET_API = "https://api-v3-devnet.raydium.io";
const DEVNET_SWAP = "https://transaction-v1-devnet.raydium.io";

type SwapSide = "buy" | "sell";

/**
 * Requests Raydium-built, unsigned CPMM swap transactions and has the
 * connected wallet sign them. No private key or signing authority leaves the
 * browser. Raydium chooses the best available route for the mint pair.
 */
export async function swapMigratedLaunch(
  connection: Connection,
  wallet: WalletContextState,
  poolId: string,
  mint: string,
  side: SwapSide,
  amountRaw: number,
  onStatus?: (message: string) => void,
) {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Connect a wallet first.");
  if (!Number.isSafeInteger(amountRaw) || amountRaw <= 0) throw new Error("Enter a valid amount.");

  const isDevnet = CLUSTER === "devnet";
  const apiHost = isDevnet ? DEVNET_API : MAINNET_API;
  const swapHost = isDevnet ? DEVNET_SWAP : MAINNET_SWAP;
  const inputMint = side === "buy" ? NATIVE_MINT.toBase58() : mint;
  const outputMint = side === "buy" ? mint : NATIVE_MINT.toBase58();
  const inputIsSol = side === "buy";
  const outputIsSol = side === "sell";

  let inputAccount: string | undefined;
  if (!inputIsSol) {
    const ata = await getAssociatedTokenAddress(new (await import("@solana/web3.js")).PublicKey(inputMint), wallet.publicKey);
    if (!await connection.getAccountInfo(ata, "confirmed")) throw new Error("You do not have a token account for this coin.");
    inputAccount = ata.toBase58();
  }

  onStatus?.("Getting Raydium quote…");
  const feeResponse = await fetch(`${apiHost}/main/auto-fee`);
  if (!feeResponse.ok) throw new Error("Raydium fee service is unavailable. Please retry.");
  const fee = await feeResponse.json();
  const quoteResponse = await fetch(
    `${swapHost}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=100&txVersion=V0`,
  );
  if (!quoteResponse.ok) throw new Error("Raydium could not quote this pool yet. Please retry shortly.");
  const swapResponse = await quoteResponse.json();
  if (!swapResponse?.success) return directCpmmSwap(connection, wallet, poolId, inputMint, outputMint, amountRaw, onStatus);

  onStatus?.("Building Raydium swap…");
  const transactionResponse = await fetch(`${swapHost}/transaction/swap-base-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      computeUnitPriceMicroLamports: String(fee.data.default.h),
      swapResponse,
      txVersion: "V0",
      wallet: wallet.publicKey.toBase58(),
      wrapSol: inputIsSol,
      unwrapSol: outputIsSol,
      inputAccount,
      outputAccount: undefined,
    }),
  });
  if (!transactionResponse.ok) throw new Error("Raydium could not build the swap transaction.");
  const built = await transactionResponse.json();
  if (!built?.success || !Array.isArray(built.data) || built.data.length === 0) throw new Error(built?.msg ?? "Raydium returned no swap transaction.");

  let lastSignature = "";
  for (const [index, item] of built.data.entries()) {
    onStatus?.(`Approve Raydium transaction ${index + 1} of ${built.data.length}…`);
    const transaction = VersionedTransaction.deserialize(Buffer.from(item.transaction, "base64"));
    const signed = await wallet.signTransaction(transaction as any) as VersionedTransaction | Transaction;
    lastSignature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(lastSignature, "confirmed");
  }
  return lastSignature;
}

async function directCpmmSwap(connection: Connection, wallet: WalletContextState, poolId: string, inputMint: string, outputMint: string, amountRaw: number, onStatus?: (message: string) => void) {
  onStatus?.("Routing directly through the Raydium pool…");
  const { Raydium, TxVersion } = await import("@raydium-io/raydium-sdk-v2");
  const BN = (await import("bn.js")).default;
  const raydium = await Raydium.load({ connection, owner: wallet.publicKey!, cluster: CLUSTER === "devnet" ? "devnet" : "mainnet", disableFeatureCheck: true, disableLoadToken: true });
  const { poolInfo, poolKeys, computePoolInfo } = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  const inputAmount = new BN(amountRaw);
  const baseIn = poolInfo.mintA.address === inputMint;
  const quote = raydium.cpmm.computeSwapAmount({ pool: computePoolInfo, amountIn: inputAmount, outputMint, slippage: 0.01 });
  const { transaction } = await raydium.cpmm.swap({ poolInfo, poolKeys, payer: wallet.publicKey!, baseIn, inputAmount, swapResult: quote.swapResult, txVersion: TxVersion.V0, config: { associatedOnly: false, checkCreateATAOwner: true } });
  onStatus?.("Approve Raydium swap…");
  const signed = await wallet.signTransaction!(transaction as any) as VersionedTransaction | Transaction;
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}
