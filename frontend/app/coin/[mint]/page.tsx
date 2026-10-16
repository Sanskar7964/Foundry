"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BondingCurveChart } from "@/components/bonding-curve-chart";
import { fetchLiveLaunch, LiveLaunch, migrationProgress } from "@/lib/anchor/launches";
import { buyTokens, migrateLaunch, raydiumPoolForLaunch, sellTokens, setLaunchMetadata, LAUNCH_METADATA_ENABLED } from "@/lib/anchor/program";
import { CLUSTER } from "@/lib/anchor/constants";
import { swapMigratedLaunch } from "@/lib/raydium-swap";
import { shortenAddress } from "@/lib/utils";
import { TRADE_FEE_PCT, STAKER_FEE_SHARE_PCT } from "@/lib/config";
import { Copy, Check } from "lucide-react";

export default function CoinPage() {
  const params = useParams<{ mint: string }>();
  const { connection } = useConnection();
  const wallet = useWallet();

  const [amount, setAmount] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [liveLaunch, setLiveLaunch] = React.useState<LiveLaunch | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [metadataName, setMetadataName] = React.useState("");
  const [metadataSymbol, setMetadataSymbol] = React.useState("");
  const [metadataUri, setMetadataUri] = React.useState("");

  React.useEffect(() => {
    let active = true;
    try {
      const mint = new PublicKey(params.mint);
      fetchLiveLaunch(connection, mint)
        .then((launch) => active && setLiveLaunch(launch))
        .catch((err) => active && setLoadError(err.message ?? "Could not load this launch from Devnet."));
    } catch {
      setLoadError("Invalid mint address.");
    }
    return () => { active = false; };
  }, [connection, params.mint]);

  if (loadError) {
    return <div className="content-wrap max-w-6xl mx-auto px-5 sm:px-8 py-10 sm:py-14 text-sm text-ember">{loadError}</div>;
  }
  if (!liveLaunch) {
    return <div className="content-wrap max-w-6xl mx-auto px-5 sm:px-8 py-10 sm:py-14 text-sm text-muted">Loading launch from Devnet…</div>;
  }

  const launch = {
    mint: liveLaunch.mint,
    name: liveLaunch.name ?? shortenAddress(liveLaunch.mint, 6),
    symbol: liveLaunch.symbol ?? "UNNAMED",
    marketCapSol: liveLaunch.realSolReserves,
    progressPct: migrationProgress(liveLaunch),
    airdropBps: liveLaunch.airdropBps,
  };

  async function copyAddress() {
    await navigator.clipboard.writeText(launch.mint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function handleTrade(side: "buy" | "sell") {
    setStatus(null);
    if (!wallet.connected) {
      setStatus("Connect a wallet first.");
      return;
    }
    const value = Number(amount);
    if (!value || value <= 0) {
      setStatus("Enter an amount greater than zero.");
      return;
    }

    setPending(true);
    try {
      const mint = new PublicKey(launch.mint);
      if (liveLaunch?.migrated) {
        const signature = await swapMigratedLaunch(
          connection, wallet, raydiumPoolForLaunch(mint).toBase58(), launch.mint, side,
          side === "buy" ? Math.round(value * 1_000_000_000) : Math.round(value * 10 ** 6),
          setStatus,
        );
        setStatus(`Raydium swap submitted: ${signature}`);
      } else if (side === "buy") {
        await buyTokens(connection, wallet, mint, Math.round(value * 1_000_000_000), 0, setStatus);
        setLiveLaunch(await fetchLiveLaunch(connection, mint));
      } else {
        await sellTokens(connection, wallet, mint, Math.round(value * 10 ** 6), 0, setStatus);
        setLiveLaunch(await fetchLiveLaunch(connection, mint));
      }
      setStatus(`${side === "buy" ? "Bought" : "Sold"} — check your wallet for the confirmation.`);
    } catch (err: any) {
      setStatus(err.message ?? "Trade failed.");
    } finally {
      setPending(false);
    }
  }

  async function handleMigration() {
    if (!wallet.connected || !wallet.publicKey || !liveLaunch) {
      setStatus("Connect a wallet first.");
      return;
    }
    setPending(true);
    setStatus(null);
    try {
      const result = await migrateLaunch(connection, wallet, new PublicKey(launch.mint), setStatus);
      setStatus(`Migration submitted: ${result.signature}`);
      setLiveLaunch(await fetchLiveLaunch(connection, new PublicKey(launch.mint)));
    } catch (err: any) {
      setStatus(err.message ?? "Migration failed.");
    } finally {
      setPending(false);
    }
  }

  async function handleMetadata() {
    if (!wallet.connected || !wallet.publicKey || !liveLaunch) {
      setStatus("Connect the launch-creator wallet first.");
      return;
    }
    if (wallet.publicKey.toBase58() !== liveLaunch.creator) {
      setStatus("Only the launch creator can add its metadata.");
      return;
    }
    setPending(true);
    setStatus(null);
    try {
      await setLaunchMetadata(
        connection,
        wallet,
        new PublicKey(launch.mint),
        metadataName.trim(),
        metadataSymbol.trim().toUpperCase(),
        metadataUri.trim(),
        setStatus
      );
      setLiveLaunch(await fetchLiveLaunch(connection, new PublicKey(launch.mint)));
      setStatus("Coin details saved on Devnet.");
    } catch (err: any) {
      setStatus(err.message ?? "Could not save coin details.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="content-wrap max-w-6xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
      <p className="eyebrow mb-3">Live bonding curve</p>
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <h1 className="font-display text-3xl text-ink">{launch.name}</h1>
        <span className="font-mono text-muted">${launch.symbol}</span>
        <Badge variant="brass">{(launch.airdropBps / 100).toFixed(0)}% to holders</Badge>
      </div>
      <button
        type="button"
        onClick={copyAddress}
        className="group mb-8 inline-flex items-center gap-2 rounded border border-border bg-surface/60 px-2.5 py-1.5 font-mono text-xs text-muted transition-colors hover:border-brass/40 hover:text-brass focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass"
        title="Copy contract address"
      >
        <span>CA {shortenAddress(launch.mint, 6)}</span>
        {copied ? <><Check size={13} className="text-brass" /><span className="text-brass">Copied</span></> : <Copy size={13} className="group-hover:text-brass" />}
      </button>

      {LAUNCH_METADATA_ENABLED && !liveLaunch.name && wallet.publicKey?.toBase58() === liveLaunch.creator && (
        <Card className="mb-6 border-brass/40">
          <CardHeader>
            <CardTitle>Add coin details</CardTitle>
            <CardDescription>This older launch has no saved name or ticker. Only its creator can backfill them.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <Input value={metadataName} onChange={(event) => setMetadataName(event.target.value)} placeholder="Name" maxLength={32} />
            <Input value={metadataSymbol} onChange={(event) => setMetadataSymbol(event.target.value.toUpperCase())} placeholder="Symbol" maxLength={10} />
            <Input value={metadataUri} onChange={(event) => setMetadataUri(event.target.value)} placeholder="Metadata URI" maxLength={200} className="sm:col-span-2" />
            <Button disabled={pending} onClick={handleMetadata}>{pending ? "Confirming…" : "Save details"}</Button>
          </CardContent>
        </Card>
      )}

      {liveLaunch.readyToMigrate && !liveLaunch.migrated && (
        <Card className="mb-6 border-brass/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div>
              <p className="font-medium text-ink">Ready to migrate to Raydium</p>
              <p className="text-xs text-muted">Anyone can create the Devnet CPMM pool. Setup costs use the curve's accrued fee surplus; LP tokens are permanently locked.</p>
            </div>
            <Button disabled={pending || !wallet.connected} onClick={handleMigration}>
              {pending ? "Confirmingâ€¦" : "Migrate to Raydium"}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{liveLaunch.migrated ? "Raydium pool" : "Bonding curve"}</CardTitle>
            <CardDescription>
              {liveLaunch.migrated
                ? "This launch graduated from the bonding curve. Trading now happens in its Raydium CPMM pool."
                : `Price rises with every buy. At ${launch.progressPct}% toward the migration threshold.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!liveLaunch.migrated && <BondingCurveChart
              initialVirtualSol={30}
              initialVirtualTokens={1_000_000_000 * (1 - launch.airdropBps / 10_000)}
              virtualTokenReserves={liveLaunch.virtualTokenReserves}
            />}
            {liveLaunch.migrated && <div className="rounded border border-border bg-surface-2 p-4 text-sm text-muted">
              <p className="mb-2 text-ink">Bonding curve trading is permanently closed.</p>
              <a className="font-mono text-xs text-brass hover:underline" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/address/${raydiumPoolForLaunch(new PublicKey(launch.mint)).toBase58()}?cluster=${CLUSTER === "mainnet-beta" ? "mainnet-beta" : "devnet"}`}>
                View Raydium pool on Solana Explorer
              </a>
            </div>}
            <div className="mt-4">
              <div className="mb-1.5 flex justify-between text-xs text-muted">
                <span>Migration progress</span>
                <span className="font-mono text-ink">{launch.progressPct}% of 85 SOL</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-brass transition-[width] duration-500" style={{ width: `${launch.progressPct}%` }} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-muted">
                <span>Curve reserves <strong className="font-mono font-normal text-ink">{liveLaunch.realSolReserves.toFixed(4)} SOL</strong></span>
                <span className="text-right">Live price <strong className="font-mono font-normal text-ink">{(liveLaunch.virtualSolReserves / liveLaunch.virtualTokenReserves).toExponential(4)} SOL</strong></span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Trade</CardTitle>
          </CardHeader>
          <CardContent>
            {liveLaunch.migrated && <p className="mb-3 text-xs text-muted">Trades are routed through Raydium; your wallet will approve the Raydium transaction.</p>}
            <Tabs defaultValue="buy">
              <TabsList className="w-full grid grid-cols-2 mb-4">
                <TabsTrigger value="buy">Buy</TabsTrigger>
                <TabsTrigger value="sell">Sell</TabsTrigger>
              </TabsList>

              <TabsContent value="buy">
                <label className="block mb-3">
                  <span className="block text-sm text-muted mb-1.5">SOL to spend</span>
                  <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                </label>
                <Button className="w-full" disabled={pending} onClick={() => handleTrade("buy")}>
                  {pending ? "Confirming…" : `Buy ${launch.symbol}`}
                </Button>
              </TabsContent>

              <TabsContent value="sell">
                <label className="block mb-3">
                  <span className="block text-sm text-muted mb-1.5">{launch.symbol} to sell</span>
                  <Input type="number" min="0" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
                </label>
                <Button variant="destructive" className="w-full" disabled={pending} onClick={() => handleTrade("sell")}>
                  {pending ? "Confirming…" : `Sell ${launch.symbol}`}
                </Button>
              </TabsContent>
            </Tabs>

            {status && <p className="text-xs text-muted mt-3">{status}</p>}

            <div className="mt-5 pt-4 border-t border-border text-xs text-muted space-y-1.5">
              <div className="flex justify-between">
                <span>Trade fee</span>
                <span className="font-mono">{TRADE_FEE_PCT}%</span>
              </div>
              <div className="flex justify-between">
                <span>→ to FOUNDRY stakers</span>
                <span className="font-mono">{STAKER_FEE_SHARE_PCT}% of fee</span>
              </div>
              <div className="flex justify-between">
                <span>→ to this coin's holder pool</span>
                <span className="font-mono">{(launch.airdropBps / 100).toFixed(0)}% of supply, at launch</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
