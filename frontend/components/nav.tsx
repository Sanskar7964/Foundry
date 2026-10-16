"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { WalletButton } from "@/components/wallet-button";
import { Flame, Coins, Gift, Hammer, Plus, Sparkles } from "lucide-react";
import { CLUSTER } from "@/lib/anchor/constants";

const links = [
  { href: "/", label: "Launches", icon: Flame },
  { href: "/stake", label: "Stake", icon: Coins },
  { href: "/claim", label: "Claim", icon: Gift },
  ...(CLUSTER === "devnet" ? [{ href: "/admin/airdrop-test", label: "Airdrop test", icon: Plus }] : []),
];

export function Nav() {
  const pathname = usePathname();

  return (
    <>
    <aside className="sticky top-0 h-screen w-[17rem] shrink-0 border-r border-border bg-surface/95 backdrop-blur hidden md:flex flex-col">
      <div className="px-5 h-20 flex items-center gap-3 border-b border-border">
        <div className="h-9 w-9 rounded-md bg-brass/15 border border-brass/30 flex items-center justify-center">
          <Hammer size={18} className="text-brass" />
        </div>
        <div>
          <span className="font-display text-lg tracking-tight block">Foundry</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">Launch terminal</span>
        </div>
      </div>

      <nav className="flex-1 px-3 py-5 flex flex-col gap-1">
        <p className="px-3 pb-2 text-[10px] font-mono uppercase tracking-[0.16em] text-muted">Workspace</p>
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 h-11 rounded-md text-sm font-medium transition-colors",
                active ? "bg-brass/15 text-brass border border-brass/20" : "text-muted hover:text-ink hover:bg-surface-2"
              )}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mx-3 mb-3 rounded-md border border-brass/20 bg-plum/40 p-3">
        <div className="flex items-center gap-2 text-brass text-xs font-medium"><Sparkles size={13} /> Built for the curve</div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">Launch tokens and share rewards with your holders.</p>
      </div>
      <div className="p-3 border-t border-border">
        <WalletButton />
      </div>
    </aside>
    <header className="md:hidden sticky top-0 z-20 h-16 border-b border-border bg-surface/95 backdrop-blur px-4 flex items-center justify-between">
      <Link href="/" className="flex items-center gap-2"><Hammer size={17} className="text-brass" /><span className="font-display">Foundry</span></Link>
      <nav className="flex items-center gap-1">
        {links.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} aria-label={label} className={cn("h-9 w-9 rounded flex items-center justify-center", pathname === href ? "bg-brass/15 text-brass" : "text-muted")}><Icon size={16} /></Link>
        ))}
      </nav>
    </header>
    </>
  );
}
