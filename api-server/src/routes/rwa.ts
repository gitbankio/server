import { Router } from "express";
import { db } from "@workspace/db";
import { rwaPositions, gitStockContracts, solanaWallets } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { getLivePrice, getAllPrices, listTickers, isValidTicker, getAsset } from "@workspace/rwa";

const router = Router();

// GET /api/rwa/stocks — list all available Ondo tickers
router.get("/rwa/stocks", async (req, res) => {
  const tickers = listTickers();

  const deployed = await db
    .select()
    .from(gitStockContracts)
    .then((rows) => Object.fromEntries(rows.map((r) => [r.ticker, r.contractAddress])));

  const stocks = tickers.map((ticker) => {
    const asset = getAsset(ticker);
    return {
      ticker,
      name: asset.name,
      mintAddress: asset.mintAddress,
      gitStockContract: deployed[ticker] ?? null,
    };
  });

  res.json(stocks);
});

// GET /api/rwa/price/:ticker — live price from Pyth
router.get("/rwa/price/:ticker", async (req, res) => {
  const { ticker } = req.params;
  if (!ticker || !isValidTicker(ticker)) {
    res.status(400).json({ error: `Unknown ticker: ${ticker}` });
    return;
  }

  try {
    const priceUsd = await getLivePrice(ticker.toUpperCase());
    res.json({ ticker: ticker.toUpperCase(), priceUsd, updatedAt: new Date().toISOString() });
  } catch (err) {
    req.log.error({ err }, "Pyth price fetch failed");
    res.status(502).json({ error: "Price feed unavailable" });
  }
});

// GET /api/rwa/portfolio — all gitStock positions for current user
router.get("/rwa/portfolio", async (req, res) => {
  if (!req.session?.githubId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const githubId = String(req.session.githubId);

  const positions = await db
    .select()
    .from(rwaPositions)
    .where(eq(rwaPositions.githubId, githubId));

  if (positions.length === 0) {
    res.json({ positions: [], totalUsd: 0 });
    return;
  }

  const tickers = positions.map((p) => p.ticker);
  let prices: Record<string, number> = {};
  try {
    prices = await getAllPrices(tickers);
  } catch {
    // If Pyth is unavailable, return without prices
  }

  const enriched = positions.map((p) => {
    const amount = BigInt(p.amount);
    const priceUsd = prices[p.ticker] ?? 0;
    const valueUsd = Number(amount) / 1_000_000_000 * priceUsd;
    const costBasis = Number(BigInt(p.costBasisUsdc)) / 1_000_000;
    const pnlUsd = valueUsd - costBasis;
    const pnlPct = costBasis > 0 ? (pnlUsd / costBasis) * 100 : 0;

    return {
      ticker: p.ticker,
      gitStockContract: p.gitStockContract,
      amount: p.amount,
      amountFormatted: (Number(amount) / 1_000_000_000).toFixed(9),
      priceUsd,
      valueUsd,
      costBasisUsd: costBasis,
      pnlUsd,
      pnlPct,
      solanaWalletPubkey: p.solanaWalletPubkey,
      buyTxSolana: p.buyTxSolana,
      buyTxBase: p.buyTxBase,
      createdAt: p.createdAt,
    };
  });

  const totalUsd = enriched.reduce((sum, p) => sum + p.valueUsd, 0);

  res.json({ positions: enriched, totalUsd });
});

// GET /api/rwa/contracts — deployed gitStock contracts on Base
router.get("/rwa/contracts", async (_req, res) => {
  const contracts = await db.select().from(gitStockContracts);
  res.json(contracts);
});

export default router;
