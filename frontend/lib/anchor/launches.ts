"use client";

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import launchpadCoreIdl from "./idl/launchpad_core.json";
import { LAUNCHPAD_CORE_PROGRAM_ID } from "./constants";
import { curvePda, launchMetadataPda } from "./pdas";

const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_DECIMALS = 1_000_000;
const MIGRATION_SOL_THRESHOLD = 85;

export interface LiveLaunch {
  mint: string; creator: string; curve: string; realSolReserves: number;
  virtualSolReserves: number; virtualTokenReserves: number; realTokenReserves: number;
  airdropBps: number; migrated: boolean; readyToMigrate: boolean;
  name?: string; symbol?: string; uri?: string;
}

function readProgram(connection: Connection) {
  return new anchor.Program(launchpadCoreIdl as unknown as anchor.Idl, { connection } as anchor.Provider);
}

function asNumber(value: { toString(): string } | number): number {
  return Number(typeof value === "number" ? value : value.toString());
}

function toLiveLaunch(curve: PublicKey, account: any): LiveLaunch {
  return {
    mint: account.mint.toBase58(), creator: account.creator.toBase58(), curve: curve.toBase58(),
    realSolReserves: asNumber(account.realSolReserves) / LAMPORTS_PER_SOL,
    virtualSolReserves: asNumber(account.virtualSolReserves) / LAMPORTS_PER_SOL,
    virtualTokenReserves: asNumber(account.virtualTokenReserves) / TOKEN_DECIMALS,
    realTokenReserves: asNumber(account.realTokenReserves) / TOKEN_DECIMALS,
    airdropBps: asNumber(account.airdropBps), migrated: account.migrated, readyToMigrate: account.readyToMigrate,
  };
}

type LaunchMetadata = Pick<LiveLaunch, "name" | "symbol" | "uri">;

function readMetadata(data: Buffer | null, owner?: PublicKey): LaunchMetadata {
  // Account layout: 8-byte Anchor discriminator, mint, creator, then three
  // Borsh strings. Missing/old metadata is intentionally a normal fallback.
  if (!data || !owner?.equals(LAUNCHPAD_CORE_PROGRAM_ID) || data.length < 8 + 32 + 32 + 13) return {};
  let offset = 8 + 32 + 32;
  const readString = (): string | undefined => {
    if (offset + 4 > data.length) return undefined;
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (length > data.length - offset) return undefined;
    const value = data.subarray(offset, offset + length).toString("utf8");
    offset += length;
    return value;
  };
  const name = readString();
  const symbol = readString();
  const uri = readString();
  return name && symbol && uri ? { name, symbol, uri } : {};
}

async function fetchMetadata(connection: Connection, mint: PublicKey): Promise<LaunchMetadata> {
  const [metadata] = launchMetadataPda(mint);
  const info = await connection.getAccountInfo(metadata, "confirmed");
  return readMetadata(info?.data ?? null, info?.owner);
}

export async function fetchLiveLaunches(connection: Connection): Promise<LiveLaunch[]> {
  const program = readProgram(connection);
  const curves: Array<{ publicKey: PublicKey; account: any }> = await (program.account as any).curve.all();
  const launches: LiveLaunch[] = curves.map(({ publicKey, account }) => toLiveLaunch(publicKey, account));
  const metadataPdas = launches.map((launch) => launchMetadataPda(new PublicKey(launch.mint))[0]);
  const accounts = metadataPdas.length ? await connection.getMultipleAccountsInfo(metadataPdas, "confirmed") : [];
  return launches.map((launch, index) => ({ ...launch, ...readMetadata(accounts[index]?.data ?? null, accounts[index]?.owner) }))
    .sort((a: LiveLaunch, b: LiveLaunch) => b.realSolReserves - a.realSolReserves);
}

export async function fetchLiveLaunch(connection: Connection, mint: PublicKey): Promise<LiveLaunch> {
  const program = readProgram(connection);
  const [curve] = curvePda(mint);
  const launch = toLiveLaunch(curve, await (program.account as any).curve.fetch(curve));
  return { ...launch, ...(await fetchMetadata(connection, mint)) };
}

export function migrationProgress(launch: LiveLaunch): number {
  return Math.min(100, Math.round((launch.realSolReserves / MIGRATION_SOL_THRESHOLD) * 100));
}
