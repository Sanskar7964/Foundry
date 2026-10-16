"use client";

import * as React from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { claimStakingRewards, stakeLaunchpadTokens, unstakeLaunchpadTokens } from "@/lib/anchor/program";
import { assertRewardVaultProgram, fetchRewardVaultState, RewardVaultState } from "@/lib/anchor/rewards";
import { STAKER_FEE_SHARE_PCT } from "@/lib/config";
import { formatTokenAmount } from "@/lib/utils";

const EMPTY: RewardVaultState = { configured: false, totalStaked: 0n, totalFeesCollected: 0n, rewardVaultBalance: 0n, userStaked: 0n, pendingReward: 0n };

export default function StakePage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [amount, setAmount] = React.useState("");
  const [state, setState] = React.useState<RewardVaultState>(EMPTY);
  const [loading, setLoading] = React.useState(true);
  const [pending, setPending] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try { setState(await fetchRewardVaultState(connection, wallet.publicKey)); }
    catch (error: any) { setStatus(error.message ?? "Could not read the reward vault."); }
    finally { setLoading(false); }
  }, [connection, wallet.publicKey]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  async function handle(action: "stake" | "unstake" | "claim") {
    setStatus(null);
    if (!wallet.connected) { setStatus("Connect a wallet first."); return; }
    if (!state.configured) { setStatus("The reward pool has not been initialized on this cluster."); return; }
    setPending(true);
    try {
      assertRewardVaultProgram();
      if (action === "claim") {
        await claimStakingRewards(connection, wallet);
        setStatus("Reward claimed.");
      } else {
        if (!/^\d+(?:\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) throw new Error("Enter a positive amount with up to 6 decimals.");
        const [whole, fraction = ""] = amount.split(".");
        const raw = Number(BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")));
        if (!Number.isSafeInteger(raw)) throw new Error("Amount is too large.");
        if (action === "stake") await stakeLaunchpadTokens(connection, wallet, raw);
        else await unstakeLaunchpadTokens(connection, wallet, raw);
        setAmount("");
        setStatus(action === "stake" ? "Stake confirmed." : "Unstake confirmed.");
      }
      await refresh();
    } catch (error: any) { setStatus(error.message ?? "Transaction failed."); }
    finally { setPending(false); }
  }

  return (
    <div className="content-wrap max-w-4xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
      <p className="eyebrow mb-3">Reward vault</p>
      <h1 className="font-display text-3xl text-ink mb-2">Stake FOUNDRY</h1>
      <p className="text-sm text-muted mb-8 max-w-2xl leading-relaxed">{STAKER_FEE_SHARE_PCT}% of every trade fee is credited proportionally to FOUNDRY stakers. These figures are read from the on-chain reward pool.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <Stat label="Total staked" value={`${formatTokenAmount(state.totalStaked)} FOUNDRY`} />
        <Stat label="Fees credited" value={`${formatTokenAmount(state.totalFeesCollected, 9)} SOL`} />
        <Stat label="Your stake" value={`${formatTokenAmount(state.userStaked)} FOUNDRY`} />
        <Stat label="Your pending reward" value={`${formatTokenAmount(state.pendingReward, 9)} SOL`} accent />
      </div>
      {!loading && !state.configured && <p className="mb-4 text-sm text-muted">The reward pool is not initialized for this cluster yet.</p>}
      <Card>
        <CardHeader><CardTitle>Manage stake</CardTitle><CardDescription>Staking and unstaking update your reward weight. Claim transfers accrued SOL from the fee vault.</CardDescription></CardHeader>
        <CardContent><Tabs defaultValue="stake"><TabsList className="w-full grid grid-cols-2 mb-4"><TabsTrigger value="stake">Stake</TabsTrigger><TabsTrigger value="unstake">Unstake</TabsTrigger></TabsList><TabsContent value="stake"><AmountForm label="FOUNDRY to stake" amount={amount} onAmount={setAmount} onSubmit={() => void handle("stake")} pending={pending || !state.configured} button="Stake" /></TabsContent><TabsContent value="unstake"><AmountForm label="FOUNDRY to unstake" amount={amount} onAmount={setAmount} onSubmit={() => void handle("unstake")} pending={pending || !state.configured} button="Unstake" outline /></TabsContent></Tabs>{status && <p className="text-xs text-muted mt-3">{status}</p>}</CardContent>
        <CardFooter><Button variant="outline" className="w-full" disabled={pending || !state.configured || state.pendingReward === 0n} onClick={() => void handle("claim")}>{pending ? "Confirming…" : `Claim ${formatTokenAmount(state.pendingReward, 9)} SOL`}</Button></CardFooter>
      </Card>
    </div>
  );
}

function AmountForm({ label, amount, onAmount, onSubmit, pending, button, outline }: { label: string; amount: string; onAmount: (value: string) => void; onSubmit: () => void; pending: boolean; button: string; outline?: boolean }) {
  return <label className="block mb-3"><span className="block text-sm text-muted mb-1.5">{label}</span><Input type="number" min="0" step="0.000001" value={amount} onChange={(event) => onAmount(event.target.value)} placeholder="0" /><Button variant={outline ? "outline" : "primary"} className="w-full mt-3" disabled={pending} onClick={onSubmit}>{pending ? "Confirming…" : button}</Button></label>;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return <div className="border border-border rounded-md bg-surface/90 px-5 py-4 shadow-[0_8px_22px_rgba(0,0,0,0.10)]"><div className="text-[11px] uppercase tracking-wide text-muted mb-1.5">{label}</div><div className={`font-mono tabular text-xl ${accent ? "text-brass" : "text-ink"}`}>{value}</div></div>;
}
