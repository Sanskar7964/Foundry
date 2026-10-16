"use client";

import * as React from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Button } from "@/components/ui/button";
import { shortenAddress } from "@/lib/utils";
import { Wallet } from "lucide-react";

export function WalletButton() {
  const { publicKey, disconnect, connected } = useWallet();
  const { setVisible } = useWalletModal();

  if (connected && publicKey) {
    return (
      <Button variant="outline" size="md" onClick={() => disconnect()} className="font-mono w-full justify-start">
        <Wallet size={14} />
        {shortenAddress(publicKey.toBase58())}
      </Button>
    );
  }

  return (
    <Button variant="primary" size="md" onClick={() => setVisible(true)} className="w-full">
      <Wallet size={14} />
      Connect wallet
    </Button>
  );
}
