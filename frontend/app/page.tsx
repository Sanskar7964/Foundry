"use client";

import * as React from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchLiveLaunches, LiveLaunch, migrationProgress } from "@/lib/anchor/launches";
import { shortenAddress } from "@/lib/utils";
import { ArrowUpRight, Plus, TrendingUp, Layers3, ShieldCheck } from "lucide-react";

export default function HomePage() {
  const { connection } = useConnection();
  const [launches, setLaunches] = React.useState<LiveLaunch[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    fetchLiveLaunches(connection)
      .then((items) => active && setLaunches(items))
      .catch((err) => active && setError(err.message ?? "Could not load launches from Devnet."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [connection]);

  const displayLaunches = launches.map((launch) => ({
    mint: launch.mint,
    name: launch.name ?? shortenAddress(launch.mint, 6),
    symbol: launch.symbol ?? "UNNAMED",
    createdAgo: `Creator ${shortenAddress(launch.creator, 4)}`,
    marketCapSol: launch.realSolReserves,
    progressPct: migrationProgress(launch),
    airdropBps: launch.airdropBps,
  }));

  return (
    <div className="content-wrap max-w-6xl mx-auto px-5 sm:px-8 py-8 sm:py-12">
      <header className="relative overflow-hidden rounded-lg border border-border bg-surface px-6 py-8 sm:px-9 sm:py-10 mb-8">
        <div className="absolute right-0 top-0 h-48 w-72 bg-brass/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <p className="eyebrow mb-3">Solana launch terminal</p>
          <h1 className="font-display text-3xl sm:text-4xl leading-[1.08] text-ink">
            Mint a coin. The curve prices it. Holders get paid twice.
          </h1>
          <p className="text-muted mt-4 text-sm leading-relaxed max-w-xl">
            Every trade feeds two vaults: 25% of the fee flows to everyone staking FOUNDRY,
            and each coin sets aside 1–5% of its own supply for its own holders, claimed epoch by epoch.
          </p>
        </div>
        <Link href="/create" className="shrink-0">
          <Button size="md">
            <Plus size={16} />
            New launch
          </Button>
        </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
        <Metric icon={TrendingUp} label="Live launches" value={String(launches.length)} detail="read from Devnet" />
        <Metric icon={Layers3} label="Holder reserve" value="1–5%" detail="set aside at every launch" />
        <Metric icon={ShieldCheck} label="Platform fee share" value="25%" detail="to FOUNDRY stakers" />
      </div>

      <div className="flex items-center justify-between mb-3">
        <div><p className="eyebrow mb-1">Discover</p><h2 className="font-display text-xl text-ink">Active launches</h2></div>
        <Badge variant="brass">Devnet — on-chain</Badge>
      </div>
      <p className="text-xs text-muted mb-3">Live Curve accounts from Devnet. Older launches without metadata are identified by mint.</p>

      <div className="border border-border rounded-md divide-y divide-border overflow-hidden shadow-[0_10px_30px_rgba(0,0,0,0.1)]">
        <div className="hidden sm:grid grid-cols-[1fr_120px_160px_100px_40px] gap-4 px-5 py-3 text-[11px] font-mono uppercase tracking-wider text-muted bg-surface-2">
          <span>Coin</span>
          <span className="text-right">Market cap</span>
          <span>Progress to migration</span>
          <span className="text-right">Holder cut</span>
          <span />
        </div>
        {loading && <div className="px-5 py-6 text-sm text-muted">Loading Curve accounts from Devnet…</div>}
        {error && <div className="px-5 py-6 text-sm text-ember">{error}</div>}
        {!loading && !error && displayLaunches.length === 0 && <div className="px-5 py-6 text-sm text-muted">No launches found on Devnet yet.</div>}
        {displayLaunches.map((l) => (
          <Link
            key={l.mint}
            href={`/coin/${l.mint}`}
            className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_120px_160px_100px_40px] gap-x-4 gap-y-3 px-5 py-4 items-center bg-surface hover:bg-surface-2 transition-colors group"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink truncate">{l.name}</span>
                <span className="text-muted text-xs font-mono">${l.symbol}</span>
              </div>
              <span className="text-xs text-muted">{l.createdAgo}</span>
            </div>
            <span className="text-right font-mono tabular text-sm"><span className="sm:hidden text-xs text-muted mr-2">MC</span>{l.marketCapSol.toFixed(1)} SOL</span>
            <div className="col-span-2 sm:col-span-1 flex items-center gap-2">
              <div className="h-1.5 flex-1 rounded-full bg-surface-2 overflow-hidden">
                <div className="h-full bg-brass" style={{ width: `${l.progressPct}%` }} />
              </div>
              <span className="text-xs text-muted w-8 text-right">{l.progressPct}%</span>
            </div>
            <span className="hidden sm:block text-right text-sm font-mono tabular text-brass">{(l.airdropBps / 100).toFixed(0)}%</span>
            <ArrowUpRight size={16} className="hidden sm:block text-muted justify-self-end group-hover:text-brass transition-colors" />
          </Link>
        ))}
      </div>
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail }: { icon: typeof TrendingUp; label: string; value: string; detail: string }) {
  return <div className="rounded-md border border-border bg-surface/75 px-4 py-4 flex items-center gap-3"><div className="h-9 w-9 shrink-0 rounded bg-brass/10 text-brass flex items-center justify-center"><Icon size={17} /></div><div><p className="text-[11px] uppercase tracking-wide text-muted">{label}</p><p className="font-mono text-lg text-ink leading-tight">{value} <span className="font-body text-xs text-muted">{detail}</span></p></div></div>;
}
