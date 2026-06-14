import { Router } from "express";
import { db, usersTable, transactionsTable, pendingTransfersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { generateKeypair, encryptPrivateKey } from "../lib/key-engine";
import {
  deployVault,
  callVault,
  readVaultNonce,
  readVaultBalance,
  getVaultByGithubId,
  buildSwapRouterData,
  computeSwapNetAmount,
  FACTORY_ADDRESS,
} from "../lib/relayer";
import { getAllTokens } from "../lib/tokens";
import { keccak256, encodePacked, type Address } from "viem";

const router = Router();

// ── Price cache (60s TTL) ────────────────────────────────────────────────────
let priceCache: { weth: number; usdc: number; fetchedAt: number } | null = null;

async function fetchUsdPrices(): Promise<{ weth: number; usdc: number }> {
  const now = Date.now();
  if (priceCache && now - priceCache.fetchedAt < 60_000) {
    return { weth: priceCache.weth, usdc: priceCache.usdc };
  }
  try {
    const resp = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,usd-coin&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) throw new Error(`CoinGecko ${resp.status}`);
    const data = await resp.json() as { ethereum?: { usd?: number }; "usd-coin"?: { usd?: number } };
    const weth = data?.ethereum?.usd ?? 0;
    const usdc = data?.["usd-coin"]?.usd ?? 0;
    priceCache = { weth, usdc, fetchedAt: now };
    return { weth, usdc };
  } catch {
    // Return stale cache if available, otherwise zeroes
    return priceCache ? { weth: priceCache.weth, usdc: priceCache.usdc } : { weth: 0, usdc: 0 };
  }
}

// GET /vault/balance
router.get("/vault/balance", requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = rows[0];
    if (!user?.vaultAddress) {
      res.json({ vaultAddress: null, balances: [], totalUsdValue: "0" });
      return;
    }

    const tokens = getAllTokens();
    const prices = await fetchUsdPrices();
    const balances: Array<{ symbol: string; address: string; balance: string; usdValue: string }> = [];

    for (const token of tokens) {
      try {
        const rawBal = await readVaultBalance(user.vaultAddress as Address, token.address);
        const humanBal = Number(rawBal) / 10 ** token.decimals;
        const usdPrice = token.symbol === "WETH" ? prices.weth : token.symbol === "USDC" ? prices.usdc : 0;
        const usdValue = (humanBal * usdPrice).toFixed(2);
        balances.push({
          symbol: token.symbol,
          address: token.address,
          balance: humanBal.toFixed(token.decimals <= 6 ? 2 : 6),
          usdValue,
        });
      } catch {
        // Skip token on RPC error -- return partial results
      }
    }

    const totalUsdValue = balances
      .reduce((sum, b) => sum + parseFloat(b.usdValue), 0)
      .toFixed(2);

    res.json({
      vaultAddress: user.vaultAddress,
      balances,
      totalUsdValue,
    });
  } catch (err) {
    req.log.error({ err }, "vault/balance error");
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /vault/deploy
router.post("/vault/deploy", requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = rows[0];
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    if (user.vaultAddress) { res.status(400).json({ error: "Vault already deployed" }); return; }
    if (!FACTORY_ADDRESS) { res.status(503).json({ error: "Factory address not configured" }); return; }

    // Generate execution keypair
    const { address: ownerAddress, privateKey } = generateKeypair();
    const encryptedPk = encryptPrivateKey(privateKey);

    // Save keypair to DB before deploying (so we never lose it)
    await db.update(usersTable)
      .set({ ownerAddress, encryptedPk })
      .where(eq(usersTable.githubId, user.githubId));

    // Deploy vault via factory (deployer pays gas, owner address passed explicitly)
    const result = await deployVault(encryptedPk, BigInt(user.githubId), ownerAddress as `0x${string}`);

    // Wait a moment then resolve vault address from factory
    // (in production, poll for tx confirmation with a background job)
    setTimeout(async () => {
      try {
        const vaultAddress = await getVaultByGithubId(BigInt(user.githubId));
        if (vaultAddress && vaultAddress !== "0x0000000000000000000000000000000000000000") {
          await db.update(usersTable)
            .set({ vaultAddress })
            .where(eq(usersTable.githubId, user.githubId));
        }
      } catch (_) {}
    }, 8000);

    // Log transaction
    await db.insert(transactionsTable).values({
      type: "lock",
      githubId: user.githubId,
      txHash: result.txHash,
      status: "pending",
    });

    res.json({ vaultAddress: "pending", ownerAddress, txHash: result.txHash });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("vault already exists")) {
      // Vault already deployed on-chain — recover the address and save to DB
      try {
        const rows2 = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
        const user2 = rows2[0];
        const vaultAddress = await getVaultByGithubId(BigInt(req.session.githubId!));
        if (vaultAddress && vaultAddress !== "0x0000000000000000000000000000000000000000") {
          await db.update(usersTable)
            .set({ vaultAddress })
            .where(eq(usersTable.githubId, req.session.githubId!));
          res.json({ vaultAddress, ownerAddress: user2?.ownerAddress ?? null, txHash: null });
          return;
        }
      } catch (_) {}
    }
    req.log.error({ err }, "vault/deploy error");
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /vault/lock
router.post("/vault/lock", requireAuth, async (req, res) => {
  try {
    const { token, amount } = req.body as { token?: string; amount?: string };
    if (!token || !amount) { res.status(400).json({ error: "token and amount required" }); return; }

    const rows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = rows[0];
    if (!user?.vaultAddress || !user.encryptedPk) { res.status(400).json({ error: "Vault not deployed" }); return; }

    const nonce = await readVaultNonce(user.vaultAddress as Address);
    const result = await callVault(user.encryptedPk, user.vaultAddress as Address, BigInt(user.githubId), "gitShield", [token as Address, BigInt(amount), nonce]);

    await db.insert(transactionsTable).values({
      type: "lock",
      githubId: user.githubId,
      tokenIn: token,
      amountIn: amount,
      txHash: result.txHash,
      status: "pending",
    });

    res.json({ txHash: result.txHash, status: result.status });
  } catch (err) {
    req.log.error({ err }, "vault/lock error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /vault/unlock
router.post("/vault/unlock", requireAuth, async (req, res) => {
  try {
    const { token, amount } = req.body as { token?: string; amount?: string };
    if (!token || !amount) { res.status(400).json({ error: "token and amount required" }); return; }

    const rows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = rows[0];
    if (!user?.vaultAddress || !user.encryptedPk) { res.status(400).json({ error: "Vault not deployed" }); return; }

    const nonce = await readVaultNonce(user.vaultAddress as Address);
    const result = await callVault(user.encryptedPk, user.vaultAddress as Address, BigInt(user.githubId), "gitUnshield", [token as Address, BigInt(amount), nonce]);

    await db.insert(transactionsTable).values({
      type: "unlock",
      githubId: user.githubId,
      tokenOut: token,
      amountOut: amount,
      txHash: result.txHash,
      status: "pending",
    });

    res.json({ txHash: result.txHash, status: result.status });
  } catch (err) {
    req.log.error({ err }, "vault/unlock error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /vault/swap
router.post("/vault/swap", requireAuth, async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn, slippageBps } = req.body as {
      tokenIn?: string; tokenOut?: string; amountIn?: string; slippageBps?: number;
    };
    if (!tokenIn || !tokenOut || !amountIn) { res.status(400).json({ error: "tokenIn, tokenOut, amountIn required" }); return; }

    const rows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = rows[0];
    if (!user?.vaultAddress || !user.encryptedPk) { res.status(400).json({ error: "Vault not deployed" }); return; }

    const minAmountOut = 0n;
    const nonce = await readVaultNonce(user.vaultAddress as Address);
    // Router gets the net amount (after 0.30% protocol fee) — mirrors GitVault._collectFee
    const netSwapAmount = computeSwapNetAmount(BigInt(amountIn));
    const { routerAddress, routerData } = await buildSwapRouterData(
      tokenIn as Address,
      tokenOut as Address,
      netSwapAmount,
      user.vaultAddress as Address, // swapped tokens go back to vault
    );
    if (!routerAddress) { res.status(503).json({ error: "DEX router not configured" }); return; }

    const result = await callVault(user.encryptedPk, user.vaultAddress as Address, BigInt(user.githubId), "gitSwap", [
      tokenIn as Address, tokenOut as Address, BigInt(amountIn), minAmountOut,
      routerAddress, routerData, nonce,
    ]);

    await db.insert(transactionsTable).values({
      type: "swap",
      githubId: user.githubId,
      tokenIn,
      tokenOut,
      amountIn,
      txHash: result.txHash,
      status: "pending",
    });

    res.json({ txHash: result.txHash, status: result.status });
  } catch (err) {
    req.log.error({ err }, "vault/swap error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /vault/transfer/init
router.post("/vault/transfer/init", requireAuth, async (req, res) => {
  try {
    const { token, recipient, amount } = req.body as { token?: string; recipient?: string; amount?: string };
    if (!token || !recipient || !amount) { res.status(400).json({ error: "token, recipient, amount required" }); return; }

    const rows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = rows[0];
    if (!user?.vaultAddress || !user.encryptedPk) { res.status(400).json({ error: "Vault not deployed" }); return; }

    const nonce = await readVaultNonce(user.vaultAddress as Address);
    const initHash = keccak256(encodePacked(
      ["uint256", "address", "address", "uint256"],
      [nonce, token as Address, recipient as Address, BigInt(amount)],
    ));

    await callVault(user.encryptedPk, user.vaultAddress as Address, BigInt(user.githubId), "initTransfer", [initHash]);

    const expiresAt = new Date(Date.now() + 600_000);
    await db.insert(pendingTransfersTable).values({
      githubId: user.githubId,
      initHash,
      initNonce: Number(nonce),
      token,
      recipient,
      amount,
      expiresAt,
    });

    res.json({ initHash, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "vault/transfer/init error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /vault/transfer/finalize
router.post("/vault/transfer/finalize", requireAuth, async (req, res) => {
  try {
    const { initHash } = req.body as { initHash?: string };
    if (!initHash) { res.status(400).json({ error: "initHash required" }); return; }

    const rows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = rows[0];
    if (!user?.vaultAddress || !user.encryptedPk) { res.status(400).json({ error: "Vault not deployed" }); return; }

    const { pendingTransfersTable: pt } = await import("@workspace/db");
    const { eq: eqF } = await import("drizzle-orm");
    const pending = await db.select().from(pt).where(eqF(pt.initHash, initHash)).limit(1);
    if (!pending[0]) { res.status(404).json({ error: "Transfer not found" }); return; }

    const p = pending[0];
    if (new Date() > p.expiresAt) { res.status(400).json({ error: "Transfer commit expired" }); return; }

    const vaultNonce = await readVaultNonce(user.vaultAddress as Address);
    const result = await callVault(user.encryptedPk, user.vaultAddress as Address, BigInt(user.githubId), "finalizeTransfer", [
      p.token as Address, p.recipient as Address, BigInt(p.amount), vaultNonce, BigInt(p.initNonce),
    ]);

    await db.insert(transactionsTable).values({
      type: "transfer",
      githubId: user.githubId,
      tokenOut: p.token,
      amountOut: p.amount,
      txHash: result.txHash,
      status: "pending",
    });

    res.json({ txHash: result.txHash, status: result.status });
  } catch (err) {
    req.log.error({ err }, "vault/transfer/finalize error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /vault/key -- export decrypted execution private key
router.get("/vault/key", requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = rows[0];
    if (!user?.encryptedPk || !user.ownerAddress) {
      res.status(400).json({ error: "Vault not deployed" });
      return;
    }
    const { decryptPrivateKey } = await import("../lib/key-engine");
    const privateKey = decryptPrivateKey(user.encryptedPk);
    res.json({ ownerAddress: user.ownerAddress, privateKey });
  } catch (err) {
    req.log.error({ err }, "vault/key error");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
