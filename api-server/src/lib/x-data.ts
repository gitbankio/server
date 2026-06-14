import { db, xUsersTable, transactionsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { publicClient, FACTORY_ADDRESS, FACTORY_ABI } from "./relayer";
import { logger } from "./logger";

const GITBANK_TOKEN_CA = "0xC21dd0eE043930711C2a3e55F39C7d3144d09B07";
const DEXSCREENER_URL  = `https://api.dexscreener.com/latest/dex/tokens/${GITBANK_TOKEN_CA}`;

export interface LiveData {
  vaultCount:   number;
  txCount:      number;
  xUserCount:   number;
  price:        string;
  priceChange:  string;
  volume24h:    string;
  liquidity:    string;
  hackathon: {
    forks:    number;
    accepted: number;
    paid:     number;
  };
}

interface DexPair {
  priceUsd?:   string;
  priceChange?: { h24?: number };
  volume?:      { h24?: number };
  liquidity?:   { usd?: number };
  txns?:        { h24?: { buys?: number; sells?: number } };
}

async function fetchDexScreener(): Promise<Partial<DexPair>> {
  try {
    const res = await fetch(DEXSCREENER_URL, {
      headers: { "User-Agent": "Gitbank-Bot/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return {};
    const data = await res.json() as { pairs?: DexPair[] };
    return data.pairs?.[0] ?? {};
  } catch {
    return {};
  }
}

async function fetchVaultCount(): Promise<number> {
  try {
    // Count x_users with vaults + github users with vaults
    const rows = await db.execute(
      sql`SELECT COUNT(*) AS cnt FROM x_users WHERE vault_address IS NOT NULL`,
    );
    const xCount = Number((rows.rows?.[0] as Record<string, unknown>)?.cnt ?? 0);

    const gRows = await db.execute(
      sql`SELECT COUNT(*) AS cnt FROM users WHERE vault_address IS NOT NULL`,
    );
    const gCount = Number((gRows.rows?.[0] as Record<string, unknown>)?.cnt ?? 0);

    return xCount + gCount;
  } catch {
    // Fallback: call factory on-chain
    try {
      const count = await publicClient.readContract({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        functionName: "hasVault",
        args: [0n],
      });
      void count;
    } catch {}
    return 0;
  }
}

async function fetchTxCount(): Promise<number> {
  try {
    const rows = await db.execute(sql`SELECT COUNT(*) AS cnt FROM transactions`);
    return Number((rows.rows?.[0] as Record<string, unknown>)?.cnt ?? 0);
  } catch {
    return 0;
  }
}

async function fetchXUserCount(): Promise<number> {
  try {
    const rows = await db.execute(sql`SELECT COUNT(*) AS cnt FROM x_users`);
    return Number((rows.rows?.[0] as Record<string, unknown>)?.cnt ?? 0);
  } catch {
    return 0;
  }
}

export async function fetchLiveData(): Promise<LiveData> {
  const [dex, vaultCount, txCount, xUserCount] = await Promise.all([
    fetchDexScreener(),
    fetchVaultCount(),
    fetchTxCount(),
    fetchXUserCount(),
  ]);

  const price       = dex.priceUsd ? `$${Number(dex.priceUsd).toFixed(6)}` : "n/a";
  const priceChange = dex.priceChange?.h24 != null
    ? `${dex.priceChange.h24 >= 0 ? "+" : ""}${dex.priceChange.h24.toFixed(2)}%`
    : "n/a";
  const volume24h   = dex.volume?.h24 != null
    ? `$${Math.round(dex.volume.h24).toLocaleString()}`
    : "n/a";
  const liquidity   = dex.liquidity?.usd != null
    ? `$${Math.round(dex.liquidity.usd).toLocaleString()}`
    : "n/a";

  return {
    vaultCount,
    txCount,
    xUserCount,
    price,
    priceChange,
    volume24h,
    liquidity,
    hackathon: { forks: 139, accepted: 100, paid: 500 },
  };
}
