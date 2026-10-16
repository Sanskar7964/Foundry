import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatSol(lamports: number): string {
  return (lamports / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function formatTokenAmount(raw: number | string | bigint, decimals = 6): string {
  const amount = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole.toLocaleString()}.${fraction.slice(0, 4)}` : whole.toLocaleString();
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
