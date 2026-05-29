import { Router } from "express";
import { db } from "@workspace/db";
import { launchedTokensTable } from "@workspace/db/schema";
import { desc, sql } from "drizzle-orm";

const router = Router();

interface ClankerTokenData {
  img_url?: string;
  related?: { market?: { marketCap?: number } };
}

async function fetchClankerToken(contractAddress: string): Promise<ClankerTokenData | null> {
  try {
    const res = await fetch(
      `https://www.clanker.world/api/tokens?contractAddress=${contractAddress}`,
      { headers: { "User-Agent": "Gitbank/1.0" }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: ClankerTokenData[] };
    return data?.data?.[0] ?? null;
  } catch {
    return null;
  }
}

router.get("/tokens", async (req, res) => {
  const tokens = await db
    .select()
    .from(launchedTokensTable)
    .orderBy(desc(launchedTokensTable.marketCapUsd), desc(launchedTokensTable.launchedAt));

  res.json(tokens);

  // Background: refresh MC + image URLs from Clanker, fire-and-forget
  void (async () => {
    const results = await Promise.allSettled(
      tokens.map(async (t) => {
        const data = await fetchClankerToken(t.contractAddress);
        if (!data) return;
        const mc = data.related?.market?.marketCap ?? 0;
        const img = data.img_url ?? null;
        // Block known generic gitbankbot IPFS avatars — don't store these as token logos
        const GENERIC_HASHES = ["bafkreiachcqehwxo4625oiwksko7b6lupwjmdzmds4yygajw7gfaytvhsu", "QmU3mSUBehH7iiS3qacbKmdYcNFT7qZt2E6kbo2"];
        const imgIsGeneric = !img || GENERIC_HASHES.some((h) => img.includes(h));
        // Never overwrite a real GitHub user-attachment image with a Clanker image
        const hasRealImage = t.imageUrl?.includes("github.com/user-attachments");
        await db
          .update(launchedTokensTable)
          .set({
            marketCapUsd: mc,
            ...(!hasRealImage && !t.imageUrl && img && !imgIsGeneric ? { imageUrl: img } : {}),
          })
          .where(sql`contract_address = ${t.contractAddress}`);
      })
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) req.log?.warn({ failed }, "Some Clanker MC refreshes failed");
  })();
});

export default router;
