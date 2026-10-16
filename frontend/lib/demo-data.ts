export interface LaunchSummary {
  mint: string;
  name: string;
  symbol: string;
  createdAgo: string;
  marketCapSol: number;
  progressPct: number; // toward migration threshold
  airdropBps: number;
}

// Demo fixtures. A real deployment reads this from an indexer (Helius/Shyft
// webhook -> Postgres, or getProgramAccounts over Curve accounts) rather than
// hardcoding it.
export const DEMO_LAUNCHES: LaunchSummary[] = [
  { mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", name: "Doge Vibes", symbol: "DVIBE", createdAgo: "2h ago", marketCapSol: 41.2, progressPct: 48, airdropBps: 300 },
  { mint: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", name: "Forge Cat", symbol: "FCAT", createdAgo: "6h ago", marketCapSol: 78.9, progressPct: 93, airdropBps: 500 },
  { mint: "3n9UnkK6dJKQLh5vqQpaJDR8x2jTgP1H7fFwR5NBu3gV", name: "Anvil Pepe", symbol: "ANVL", createdAgo: "1d ago", marketCapSol: 12.5, progressPct: 15, airdropBps: 100 },
  { mint: "5CqQGXxbA1kYdT8fx3zP2mZ9nR7wJXeK6oLpVsN4cYuT", name: "Molten Wojak", symbol: "MELT", createdAgo: "3d ago", marketCapSol: 5.6, progressPct: 7, airdropBps: 250 },
];
