/**
 * Creates the single reward-vault pool used by launchpad-core fee routing.
 * Safe to rerun: if the pool PDA already exists, it prints its address and
 * exits without sending a transaction.
 *
 * Usage (devnet):
 * SOLANA_RPC_URL=https://api.devnet.solana.com \
 * SOLANA_WALLET_PATH=~/.config/solana/id.json \
 * LAUNCHPAD_TOKEN_MINT=<FOUNDRY_MINT> \
 * npx ts-node app/initialize-reward-pool.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import path from "path";

const REWARD_VAULT_PROGRAM_ID = new PublicKey("3xUJqsjCQBfvUhEvz5cd16SSAwLdQUFGijoh3X5pLYPZ");
function readFrontendEnvironment(name: string): string | undefined {
  const environmentPath = path.resolve(__dirname, "../frontend/.env.local");
  if (!fs.existsSync(environmentPath)) return undefined;
  const match = fs.readFileSync(environmentPath, "utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}=`));
  return match?.slice(name.length + 1).trim() || undefined;
}

const launchpadTokenMint = process.env.LAUNCHPAD_TOKEN_MINT
  ?? readFrontendEnvironment("NEXT_PUBLIC_LAUNCHPAD_TOKEN_MINT");
if (!launchpadTokenMint) {
  throw new Error("Set LAUNCHPAD_TOKEN_MINT or NEXT_PUBLIC_LAUNCHPAD_TOKEN_MINT in frontend/.env.local.");
}
const LAUNCHPAD_TOKEN_MINT = new PublicKey(launchpadTokenMint);

async function main() {
  const walletPath = process.argv[2] ?? process.env.SOLANA_WALLET_PATH;
  if (!walletPath) {
    throw new Error("Pass the Solana keypair path as the first argument, or set SOLANA_WALLET_PATH.");
  }
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Solana keypair file was not found: ${walletPath}`);
  }
  const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")))));
  const provider = new anchor.AnchorProvider(
    new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed"),
    wallet,
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), LAUNCHPAD_TOKEN_MINT.toBuffer()],
    REWARD_VAULT_PROGRAM_ID
  );
  const [vaultSol] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_sol"), LAUNCHPAD_TOKEN_MINT.toBuffer()],
    REWARD_VAULT_PROGRAM_ID
  );

  if (await provider.connection.getAccountInfo(pool, "confirmed")) {
    console.log(`Reward pool already initialized: ${pool.toBase58()}`);
    console.log(`SOL fee vault: ${vaultSol.toBase58()}`);
    return;
  }

  const idlPath = path.resolve(__dirname, "../target/idl/reward_vault.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, provider);
  const stakeVault = Keypair.generate();

  const signature = await (program.methods.initializePool() as any).accounts({
    payer: provider.wallet.publicKey,
    stakeMint: LAUNCHPAD_TOKEN_MINT,
    pool,
    vaultSol,
    stakeVault: stakeVault.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  }).signers([stakeVault]).rpc();

  console.log(`Initialized reward pool: ${pool.toBase58()}`);
  console.log(`Stake vault: ${stakeVault.publicKey.toBase58()}`);
  console.log(`SOL fee vault: ${vaultSol.toBase58()}`);
  console.log(`Transaction: https://solscan.io/tx/${signature}?cluster=devnet`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
