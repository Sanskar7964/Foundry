import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import fs from "node:fs";

// Devnet only. This creates and approves a Vault transaction; it does not
// execute the program upgrade.
const RPC_URL = "https://api.devnet.solana.com";
const MULTISIG_PDA = new PublicKey("C4WBJRjmLUJwUkFxD9CaBopspDpeFkeniRAK7Bt7ML7F");
const VAULT_PDA = new PublicKey("");
const PROGRAM_ID = new PublicKey("HbYcvC9n5ZhE1LhVzpmRWLfBVg7oimsDaY7e2Rz8K2Mn");
const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const memberPath = process.argv[2];
const bufferText = process.argv[3];
if (!memberPath || !bufferText) {
  throw new Error("Usage: npm run squad:propose-upgrade -- <MEMBER_1_KEYPAIR_PATH> <BUFFER_ADDRESS>");
}
const BUFFER_ADDRESS = new PublicKey(bufferText);
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

function assertProgramDataAuthority(data: Buffer): void {
  assert(data.length >= 45, "Program-data account is too small.");
  assert(data.readUInt32LE(0) === 3, "Derived account is not an UpgradeableLoader ProgramData account.");
  assert(data[12] === 1, "The launchpad program is immutable.");
  const authority = new PublicKey(data.subarray(13, 45));
  assert(authority.equals(VAULT_PDA), `Program authority is ${authority.toBase58()}, not the Devnet Vault.`);
}

function assertBufferAuthority(data: Buffer): void {
  assert(data.length >= 37, "Buffer account is too small.");
  assert(data.readUInt32LE(0) === 1, "Provided address is not an upgrade buffer.");
  assert(data[4] === 1, "Buffer has no authority.");
  const authority = new PublicKey(data.subarray(5, 37));
  assert(authority.equals(VAULT_PDA), `Buffer authority is ${authority.toBase58()}, not the Devnet Vault.`);
}

async function send(label: string, build: (blockhash: string) => any, signer: Keypair): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = build(latest.blockhash);
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
  assert(Permissions.has(memberRecord.permissions, Permission.Initiate), "Member lacks Initiate permission.");
  assert(Permissions.has(memberRecord.permissions, Permission.Vote), "Member lacks Vote permission.");

  const [derivedVault] = multisig.getVaultPda({ multisigPda: MULTISIG_PDA, index: 0 });
  assert(derivedVault.equals(VAULT_PDA), "Configured Vault PDA does not match the multisig's vault 0.");
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE_LOADER);
  const [programInfo, programDataInfo, bufferInfo] = await Promise.all([
    connection.getAccountInfo(PROGRAM_ID, "confirmed"),
    connection.getAccountInfo(programData, "confirmed"),
    connection.getAccountInfo(BUFFER_ADDRESS, "confirmed"),
  ]);
  assert(programInfo?.executable && programInfo.owner.equals(BPF_UPGRADEABLE_LOADER), "Launchpad program is not upgradeable-loader owned.");
  assert(programDataInfo?.owner.equals(BPF_UPGRADEABLE_LOADER), "Program-data account is invalid.");
  assert(bufferInfo?.owner.equals(BPF_UPGRADEABLE_LOADER), "Buffer account is invalid.");
  assertProgramDataAuthority(programDataInfo.data);
  assertBufferAuthority(bufferInfo.data);
  const currentElfBytes = programDataInfo.data.length - 45;
  const bufferElfBytes = bufferInfo.data.length - 37;
  const additionalBytes = Math.max(0, bufferElfBytes - currentElfBytes);
  assert(
    additionalBytes === 0,
    `ProgramData needs ${additionalBytes} more bytes. Run: solana program extend ${PROGRAM_ID.toBase58()} ${additionalBytes} --url devnet, then rerun this command.`,
  );

  const transactionIndex = BigInt(multisigAccount.transactionIndex.toString()) + BigInt("1");
  const upgradeInstruction = new TransactionInstruction({
    programId: BPF_UPGRADEABLE_LOADER,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: BUFFER_ADDRESS, isSigner: false, isWritable: true },
      { pubkey: member.publicKey, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: VAULT_PDA, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([3, 0, 0, 0]), // UpgradeableLoaderInstruction::Upgrade
  });
  const message = new TransactionMessage({
    payerKey: VAULT_PDA,
    recentBlockhash: (await connection.getLatestBlockhash("confirmed")).blockhash,
    instructions: [upgradeInstruction],
  });

  console.log(`Devnet proposal index: ${transactionIndex}`);
  await send("Vault transaction created", (blockhash) => multisig.transactions.vaultTransactionCreate({
    blockhash, feePayer: member.publicKey, multisigPda: MULTISIG_PDA,
    transactionIndex, creator: member.publicKey, vaultIndex: 0, ephemeralSigners: 0,
    transactionMessage: message, memo: "Devnet launchpad metadata upgrade",
  }), member);
  await send("Proposal activated", (blockhash) => multisig.transactions.proposalCreate({
    blockhash, feePayer: member.publicKey, creator: member.publicKey,
    multisigPda: MULTISIG_PDA, transactionIndex,
  }), member);
  await send("First approval submitted", (blockhash) => multisig.transactions.proposalApprove({
    blockhash, feePayer: member.publicKey, member: member.publicKey,
    multisigPda: MULTISIG_PDA, transactionIndex, memo: "Approve Devnet launchpad metadata upgrade",
  }), member);
  console.log(`Next: npm run squad:approve-execute -- <MEMBER_2_KEYPAIR_PATH> ${transactionIndex}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
