"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MIN_AIRDROP_PCT, MAX_AIRDROP_PCT } from "@/lib/config";
import { createLaunch } from "@/lib/anchor/program";

export default function CreateLaunchPage() {
  const router = useRouter();
  const { connection } = useConnection();
  const wallet = useWallet();

  const [name, setName] = React.useState("");
  const [symbol, setSymbol] = React.useState("");
  const [uri, setUri] = React.useState("");
  const [airdropPct, setAirdropPct] = React.useState(3);
  const [submitting, setSubmitting] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);

    if (!wallet.connected) {
      setError("Connect a wallet first.");
      return;
    }

    setSubmitting(true);
    try {
      // Real call once the workspace is built and IDLs copied in:
      //   const mint = Keypair.generate();
      //   await getLaunchpadCoreProgram(connection, wallet).methods
      //     .createLaunch(name, symbol, uri, airdropPct * 100)
      //     .accounts({ ...creator, mint, curve, curveAuthority, curveTokenVault, airdropVault... })
      //     .signers([mint])
      //     .rpc();
      const { mint } = await createLaunch(
        connection,
        wallet,
        name.trim(),
        symbol.trim(),
        uri.trim(),
        Math.round(airdropPct * 100),
        setStatus
      );
      router.push(`/coin/${mint.toBase58()}`);
    } catch (err: any) {
      setError(err.message ?? "Something went wrong creating the launch.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="content-wrap max-w-xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
      <p className="eyebrow mb-3">Create / new asset</p>
      <h1 className="font-display text-3xl text-ink mb-2">Forge a new launch</h1>
      <p className="text-sm text-muted mb-7 max-w-lg leading-relaxed">
        1B supply, minted on a bonding curve. Pick how much of it goes straight to your holders.
      </p>

      <form onSubmit={handleSubmit}>
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Coin details</CardTitle>
            <CardDescription>Shown on the trading page and in wallets.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Forge Cat" maxLength={32} required />
            </Field>
            <Field label="Symbol">
              <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="FCAT" maxLength={10} required />
            </Field>
            <Field label="Metadata URI">
              <Input value={uri} onChange={(e) => setUri(e.target.value)} placeholder="https://…/metadata.json" required />
            </Field>
            <Field label={`Holder airdrop reserve — ${airdropPct}% of supply`}>
              <div className="rounded-md border border-border bg-base px-3 pt-3 pb-2">
              <input
                type="range"
                min={MIN_AIRDROP_PCT}
                max={MAX_AIRDROP_PCT}
                step={0.5}
                value={airdropPct}
                onChange={(e) => setAirdropPct(Number(e.target.value))}
                className="w-full accent-brass"
              />
              <div className="flex justify-between text-xs text-muted mt-1">
                <span>{MIN_AIRDROP_PCT}% minimum</span>
                <span>{MAX_AIRDROP_PCT}% maximum</span>
              </div>
              </div>
            </Field>
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3">
            {error && <p className="text-sm text-ember">{error}</p>}
            {status && !error && <p className="text-sm text-muted">{status}</p>}
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? "Creating…" : "Create launch"}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm text-muted mb-1.5">{label}</span>
      {children}
    </label>
  );
}
