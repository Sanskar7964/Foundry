/**
 * Devnet migration keeper. Run only with MIGRATION_KEEPER_ENABLED=true.
 * It never holds launch funds: the curve treasury funds pool setup and this
 * wallet only pays normal transaction/ATA rent.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn");
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const POLL_MS = Number(process.env.MIGRATION_KEEPER_POLL_MS ?? "15000");
const ONLY_MINT = process.env.MIGRATION_KEEPER_MINT;

function requireConfig() {
  if (process.env.MIGRATION_KEEPER_ENABLED !== "true") {
    throw new Error("Set MIGRATION_KEEPER_ENABLED=true to run the keeper.");
  }
  if ((process.env.CLUSTER ?? "devnet") !== "devnet") {
    throw new Error("This keeper is Devnet-only. Refusing to run outside CLUSTER=devnet.");
  }
  const secret = process.env.SOLANA_KEEPER_SECRET_KEY;
  if (!secret) throw new Error("Set SOLANA_KEEPER_SECRET_KEY to the JSON contents of a dedicated Devnet keeper keypair.");
  let bytes: unknown;
  try { bytes = JSON.parse(secret); } catch { throw new Error("SOLANA_KEEPER_SECRET_KEY must be a JSON keypair byte array."); }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new Error("SOLANA_KEEPER_SECRET_KEY is not a valid 64-byte Solana keypair array.");
  }
  if (ONLY_MINT) new PublicKey(ONLY_MINT);
  const keyPath = path.join(os.tmpdir(), "launchpad-migration-keeper.json");
  fs.writeFileSync(keyPath, JSON.stringify(bytes), { encoding: "utf8", mode: 0o600 });
  process.env.SOLANA_WALLET_PATH = keyPath;
}

async function readyMints(connection: Connection): Promise<string[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 142 }] });
  return accounts.flatMap(({ account }) => {
    // Curve layout: 8-byte discriminator, mint, creator, authority, four u64s,
    // u16 airdrop_bps, migrated byte, ready_to_migrate byte, two bump bytes.
    const data = account.data;
    if (data.length !== 142 || data[138] !== 0 || data[139] !== 1) return [];
    const mint = new PublicKey(data.subarray(8, 40)).toBase58();
    return !ONLY_MINT || mint === ONLY_MINT ? [mint] : [];
  });
}

function migrate(mint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "migrate", "--", mint], { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Migration process exited with ${code}.`)));
  });
}

async function tick(connection: Connection) {
  const mints = await readyMints(connection);
  for (const mint of mints) {
    console.log(`[keeper] migrating ready curve ${mint}`);
    try { await migrate(mint); }
    catch (error) { console.error(`[keeper] ${mint}:`, error instanceof Error ? error.message : error); }
  }
}

async function main() {
  requireConfig();
  const connection = new Connection(RPC_URL, "confirmed");
  console.log(`[keeper] Devnet migration keeper started; polling every ${POLL_MS}ms${ONLY_MINT ? ` for ${ONLY_MINT}` : ""}.`);
  await tick(connection);
  setInterval(() => { tick(connection).catch((error) => console.error("[keeper] scan failed:", error)); }, POLL_MS);
}

main().catch((error) => { console.error("[keeper] fatal:", error); process.exit(1); });
