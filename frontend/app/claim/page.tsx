"use client";

import * as React from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { claimHolderAirdrop } from "@/lib/anchor/program";
import { ClaimWithStatus, fetchWalletClaims } from "@/lib/anchor/claims";
import { formatTokenAmount, shortenAddress } from "@/lib/utils";
import { Gift } from "lucide-react";

export default function ClaimPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [claims, setClaims] = React.useState<ClaimWithStatus[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<Record<string, string>>({});
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!wallet.publicKey) { setClaims([]); return; }
    setLoading(true); setLoadError(null);
    try { setClaims(await fetchWalletClaims(connection, wallet.publicKey)); }
    catch (error: any) { setLoadError(error.message ?? "Could not load airdrop proofs."); }
    finally { setLoading(false); }
  }, [connection, wallet.publicKey]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  async function handleClaim(claim: ClaimWithStatus) {
    const key = `${claim.mint}-${claim.epoch}`;
    if (!wallet.connected) { setStatus((current) => ({ ...current, [key]: "Connect a wallet first." })); return; }
    setPendingKey(key);
    try {
      await claimHolderAirdrop(connection, wallet, new PublicKey(claim.mint), claim.epoch, claim.amount, claim.proof.map((node) => Buffer.from(node, "hex")));
      setStatus((current) => ({ ...current, [key]: "Claimed." }));
      await refresh();
    } catch (error: any) {
      setStatus((current) => ({ ...current, [key]: error.message ?? "Claim failed." }));
    } finally { setPendingKey(null); }
  }

  return (
    <div className="content-wrap max-w-3xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
      <p className="eyebrow mb-3">Holder rewards</p>
      <h1 className="font-display text-3xl text-ink mb-2">Your airdrops</h1>
      <p className="text-sm text-muted mb-8 max-w-xl leading-relaxed">Claims are loaded from the keeper-published, Merkle-proof manifest for your connected wallet.</p>
      {!wallet.publicKey && <Card><CardContent className="py-5 text-sm text-muted">Connect the wallet that held the coin at the epoch snapshot to see available claims.</CardContent></Card>}
      {loadError && <p className="mb-4 text-sm text-ember">{loadError}</p>}
      {loading && <p className="text-sm text-muted">Loading your claims…</p>}
      {!loading && wallet.publicKey && claims.length === 0 && <Card><CardContent className="py-5 text-sm text-muted">No published airdrop claims match this wallet yet.</CardContent></Card>}
      <div className="flex flex-col gap-3">
        {claims.map((claim) => {
          const key = `${claim.mint}-${claim.epoch}`;
          const title = claim.name ?? shortenAddress(claim.mint, 6);
          const symbol = claim.symbol ?? "TOKEN";
          const state = status[key] ?? (claim.claimed ? "Already claimed" : !claim.available ? "Epoch is not live on-chain" : "Ready to claim");
          return <Card key={key}><CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between py-4"><div className="flex items-center gap-3"><div className="w-9 h-9 rounded bg-surface-2 flex items-center justify-center"><Gift size={16} className="text-brass" /></div><div><div className="flex items-center gap-2"><span className="font-medium text-ink">{title}</span><span className="font-mono text-xs text-muted">${symbol}</span><Badge variant="default">epoch {claim.epoch}</Badge></div><span className="text-xs text-muted">{state}</span></div></div><div className="flex items-center justify-between sm:justify-normal gap-3"><span className="font-mono tabular text-sm text-ink">{formatTokenAmount(claim.amount)} {symbol}</span><Button size="sm" disabled={claim.claimed || !claim.available || pendingKey === key} onClick={() => void handleClaim(claim)}>{pendingKey === key ? "Confirming…" : claim.claimed ? "Claimed" : "Claim"}</Button></div></CardContent></Card>;
        })}
      </div>
    </div>
  );
}
