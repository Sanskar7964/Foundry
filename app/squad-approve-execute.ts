import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import fs from "node:fs";

// Devnet only. This is the second member's approval and the Vault execution.
const RPC_URL = "https://api.devnet.solana.com";
const MULTISIG_PDA = new PublicKey("C4WBJRjmLUJwUkFxD9CaBopspDpeFkeniRAK7Bt7ML7F");
const memberPath = process.argv[2];
const indexText = process.argv[3];
if (!memberPath || !indexText || !/^\d+$/.test(indexText)) {
  throw new Error("Usage: npm run squad:approve-execute -- <MEMBER_2_KEYPAIR_PATH> <PROPOSAL_INDEX>");
}
const transactionIndex = BigInt(indexText);
const connection = new Connection(RPC_URL, "confirmed");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function loadKeypair(path: string): Keypair {
  assert(fs.existsSync(path), `Keypair file does not exist: ${path}`);
  const bytes = JSON.parse(fs.readFileSync(path, "utf8"));
  assert(Array.isArray(bytes) && bytes.length === 64, `Invalid Solana keypair file: ${path}`);
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function send(label: string, build: (blockhash: string) => any, signer: Keypair): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = await build(latest.blockhash);
  transaction.sign([signer]);
  const signature = await connection.sendTransaction(transaction, { preflightCommitment: "confirmed", maxRetries: 3 });
  const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  assert(!result.value.err, `${label} failed: ${JSON.stringify(result.value.err)}`);
  console.log(`${label}: ${signature}`);
  return signature;
}

async function main(): Promise<void> {
  const member = loadKeypair(memberPath);
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(connection, MULTISIG_PDA);
  const memberRecord = multisigAccount.members.find(({ key }) => key.equals(member.publicKey));
  assert(memberRecord, `${member.publicKey.toBase58()} is not a member of this Devnet multisig.`);
  const { Permission, Permissions } = multisig.types;
  assert(Permissions.has(memberRecord.permissions, Permission.Vote), "Member lacks Vote permission.");
  assert(Permissions.has(memberRecord.permissions, Permission.Execute), "Member lacks Execute permission.");

  const [proposalPda] = multisig.getProposalPda({ multisigPda: MULTISIG_PDA, transactionIndex });
  let proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
  console.log(`Proposal: ${proposalPda.toBase58()}`);
  console.log(`Status: ${proposal.status.__kind}`);
  if (!proposal.approved.some((key) => key.equals(member.publicKey))) {
    assert(proposal.status.__kind === "Active", `Proposal is ${proposal.status.__kind}; it cannot receive this approval.`);
    await send("Second approval submitted", (blockhash) => multisig.transactions.proposalApprove({
      blockhash, feePayer: member.publicKey, member: member.publicKey,
      multisigPda: MULTISIG_PDA, transactionIndex, memo: "Second approval for Devnet launchpad metadata upgrade",
    }), member);
    proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
  }
  assert(proposal.status.__kind === "Approved", `Proposal is ${proposal.status.__kind}, not Approved.`);
  await send("Devnet upgrade executed", (blockhash) => multisig.transactions.vaultTransactionExecute({
    connection, blockhash, feePayer: member.publicKey, multisigPda: MULTISIG_PDA,
    transactionIndex, member: member.publicKey,
  }), member);
  proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
  assert(proposal.status.__kind === "Executed", `Expected Executed, got ${proposal.status.__kind}.`);
  console.log("Devnet launchpad upgrade complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
