"use client";

import * as React from "react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CLUSTER } from "@/lib/anchor/constants";
import {
  claimHolderAirdrop,
  createSingleLeafDistributor,
  fundDistributor,
  getMerkleKeeper,
  initializeMerkleKeeper,
} from "@/lib/anchor/program";
import { distributorPda } from "@/lib/anchor/pdas";

const TEST_MINT = "g3FewdJ6QjEpgBGZQc14PD6RTXan77EyZHmNFQ7wyS9";
const TEST_HOLDER = "7Zes8mypmy9X3a8pPVwQMowzoqdogAUxJsSrU8drT7XY";
const TEST_AMOUNT = "1000000"; // one token at six decimals

function solscanTx(signature: string) {
  return `https://solscan.io/tx/${signature}?cluster=devnet`;
}

export default function AirdropTestPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [mint, setMint] = React.useState(TEST_MINT);
  const [holder, setHolder] = React.useState(TEST_HOLDER);
  const [epoch, setEpoch] = React.useState("1");
  const [amount, setAmount] = React.useState(TEST_AMOUNT);
  const [keeper, setKeeper] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState("Connect a Devnet wallet to inspect keeper status.");
  const [busy, setBusy] = React.useState(false);
  const [signature, setSignature] = React.useState<string | null>(null);
  const [distributorExists, setDistributorExists] = React.useState(false);

  const parsed = (() => {
    try {
      return { mint: new PublicKey(mint), holder: new PublicKey(holder), epoch: Number(epoch) };
    } catch {
      return null;
    }
  })();

  const inspect = React.useCallback(async () => {
    if (!wallet.publicKey) return;
    try {
      const result = await getMerkleKeeper(connection, wallet);
      setKeeper(result.authority?.toBase58() ?? null);
      setStatus(result.authority ? `Keeper: ${result.authority.toBase58()}` : "Keeper is uninitialized. Only initialize it with the intended keeper wallet.");
    } catch (error: any) {
      setStatus(error?.message ?? "Unable to inspect keeper configuration.");
    }
  }, [connection, wallet]);

  React.useEffect(() => { void inspect(); }, [inspect]);

  React.useEffect(() => {
    let active = true;
    if (!parsed || !Number.isSafeInteger(parsed.epoch) || parsed.epoch < 0) {
      setDistributorExists(false);
      return () => { active = false; };
    }
    const [distributor] = distributorPda(parsed.mint, parsed.epoch);
    connection.getAccountInfo(distributor, "confirmed")
      .then((account) => active && setDistributorExists(account !== null))
      .catch(() => active && setDistributorExists(false));
    return () => { active = false; };
  }, [connection, mint, epoch]);

  async function run(action: () => Promise<string>, success: string) {
    setBusy(true);
    setSignature(null);
    try {
      const tx = await action();
      setSignature(tx);
      setStatus(success);
      await inspect();
    } catch (error: any) {
      setStatus(error?.message ?? "Transaction failed.");
    } finally {
      setBusy(false);
    }
  }

  if (CLUSTER !== "devnet") {
    return <main className="content-wrap max-w-2xl mx-auto px-5 py-12"><p className="text-sm text-muted">This test panel is available on Devnet only.</p></main>;
  }

  const isKeeper = Boolean(wallet.publicKey && keeper && wallet.publicKey.toBase58() === keeper);
  const distributor = parsed ? distributorPda(parsed.mint, parsed.epoch)[0].toBase58() : "Enter valid mint and epoch";

  return (
    <main className="content-wrap max-w-3xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
      <div className="flex items-center gap-3 mb-3"><p className="eyebrow">Devnet only</p><Badge variant="default">Admin test</Badge></div>
      <h1 className="font-display text-3xl text-ink mb-2">Airdrop escrow test</h1>
      <p className="text-sm text-muted mb-8">One holder, one token, empty Merkle proof. This panel is intentionally unavailable on mainnet.</p>

      <Card className="mb-4"><CardHeader><CardTitle>Test inputs</CardTitle></CardHeader><CardContent className="grid gap-4">
        <label className="text-sm">Mint<Input value={mint} onChange={(e) => setMint(e.target.value.trim())} /></label>
        <label className="text-sm">Holder wallet<Input value={holder} onChange={(e) => setHolder(e.target.value.trim())} /></label>
        <div className="grid sm:grid-cols-2 gap-4"><label className="text-sm">Epoch<Input value={epoch} onChange={(e) => setEpoch(e.target.value)} /></label><label className="text-sm">Raw amount (6 decimals)<Input value={amount} onChange={(e) => setAmount(e.target.value)} /></label></div>
        <p className="font-mono text-xs text-muted break-all">Distributor PDA: {distributor}</p>
      </CardContent></Card>

      <Card className="mb-4"><CardHeader><CardTitle>1. Keeper</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted">{keeper ? `Registered keeper: ${keeper}` : "No keeper is registered. The connected wallet will become the global Devnet keeper."}</p>
        <div className="flex gap-2"><Button variant="outline" onClick={() => void inspect()} disabled={!wallet.publicKey || busy}>Refresh</Button>{!keeper && <Button onClick={() => void run(() => initializeMerkleKeeper(connection, wallet), "Keeper initialized. Continue as this wallet.")} disabled={!wallet.publicKey || busy}>Initialize keeper</Button>}</div>
      </CardContent></Card>

      <Card className="mb-4"><CardHeader><CardTitle>2. Create and fund epoch</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted">Connect the registered keeper to create the distributor. Connect the launch creator to fund it from the PDA escrow.</p>
        <p className="text-xs text-muted">{distributorExists ? "Distributor exists: it can now be funded by the launch creator." : "No distributor exists for this mint and epoch yet. Create it before funding."}</p>
        <div className="flex flex-wrap gap-2"><Button onClick={() => void run(async () => {
          if (!parsed) throw new Error("Enter valid mint, holder, and epoch.");
          const result = await createSingleLeafDistributor(connection, wallet, parsed.mint, parsed.epoch, parsed.holder, amount);
          setDistributorExists(true);
          return result.signature;
        }, "Distributor created. Now connect the launch creator and fund it.")} disabled={!parsed || !isKeeper || busy || distributorExists}>Create one-leaf epoch</Button>
        <Button variant="outline" onClick={() => void run(async () => {
          if (!parsed) throw new Error("Enter valid mint and epoch.");
          const rawAmount = Number(amount);
          if (!Number.isSafeInteger(rawAmount) || rawAmount <= 0) throw new Error("Use a positive safe raw token amount.");
          const [epochDistributor] = distributorPda(parsed.mint, parsed.epoch);
          const epochVault = await getAssociatedTokenAddress(parsed.mint, epochDistributor, true);
          return fundDistributor(connection, wallet, parsed.mint, epochDistributor, epochVault, rawAmount);
        }, "Epoch funded from the program-owned airdrop reserve.")} disabled={!parsed || !wallet.publicKey || busy || !distributorExists}>Fund epoch</Button></div>
      </CardContent></Card>

      <Card><CardHeader><CardTitle>3. Claim</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted">Switch Phantom to the holder wallet. This one-leaf epoch uses an empty proof.</p>
        <Button onClick={() => void run(async () => {
          if (!parsed) throw new Error("Enter valid mint and epoch.");
          if (!wallet.publicKey?.equals(parsed.holder)) throw new Error("Connect the holder wallet shown above before claiming.");
          return claimHolderAirdrop(connection, wallet, parsed.mint, parsed.epoch, amount, []);
        }, "Claim succeeded. Retrying it must fail because the receipt PDA now exists.")} disabled={!parsed || !wallet.publicKey || busy}>Claim one-leaf airdrop</Button>
        <p className="text-sm text-muted">{status}</p>
        {signature && <a className="text-sm text-brass underline break-all" href={solscanTx(signature)} target="_blank" rel="noreferrer">View latest transaction on Solscan</a>}
      </CardContent></Card>
    </main>
  );
}
