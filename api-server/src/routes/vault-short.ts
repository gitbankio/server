import { Router } from "express";
import { db, xUsersTable, pendingDepositsTable, transactionsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { getAllTokens } from "../lib/tokens";

const router = Router();

const NETWORK_LABEL = process.env["BASE_NETWORK"] === "mainnet" ? "Base Mainnet" : "Base Sepolia";
const EXPLORER_TX   = process.env["BASE_NETWORK"] === "mainnet"
  ? "https://basescan.org/tx"
  : "https://sepolia.basescan.org/tx";

/** Resolve decimals for a token address using the configured token list. Fallback: 18. */
function getDecimals(tokenAddress: string | null | undefined): number {
  if (!tokenAddress) return 18;
  const token = getAllTokens().find(
    (t) => t.address.toLowerCase() === tokenAddress.toLowerCase(),
  );
  return token?.decimals ?? 18;
}

/** Format a raw bigint-as-string amount to a human-readable string. */
function humanAmount(raw: string | null | undefined, decimals: number): string | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!isFinite(n)) return null;
  return (n / 10 ** decimals).toFixed(decimals === 6 ? 2 : decimals === 8 ? 6 : 6);
}

/**
 * GET /api/v/:xUserId
 * Returns vault info + pending/completed deposit status for the deposit tracker page.
 * All queries are scoped to the requesting user — no cross-user data leakage.
 */
router.get("/v/:xUserId", async (req, res) => {
  const { xUserId } = req.params;
  try {
    const [xUser] = await db
      .select({ vaultAddress: xUsersTable.vaultAddress })
      .from(xUsersTable)
      .where(eq(xUsersTable.xUserId, xUserId!))
      .limit(1);

    if (!xUser?.vaultAddress) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    const { vaultAddress } = xUser;

    // Pending deposit — scoped to this user's vault address
    const pendingRows = await db
      .select()
      .from(pendingDepositsTable)
      .where(
        and(
          eq(pendingDepositsTable.trackingAddress, vaultAddress),
          eq(pendingDepositsTable.repo, "x-bot"),
        ),
      )
      .limit(1);

    const pending = pendingRows[0] ?? null;

    // Completed tx — scoped to this user's githubId (stored as Number(BigInt(xUserId)))
    // Same precision-loss path used when writing, so the values match.
    const userGithubId = Number(BigInt(xUserId!));
    const completedRows = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.githubId, userGithubId),
          eq(transactionsTable.type, "lock"),
        ),
      )
      .orderBy(desc(transactionsTable.createdAt))
      .limit(1);

    const latest = completedRows[0] ?? null;

    // Pending deposit info
    const pendingDecimals = getDecimals(pending?.token);
    const pendingAmount   = pending?.amountExpected && pending.amountExpected !== "0"
      ? humanAmount(pending.amountExpected, pendingDecimals)
      : null;

    // Completed tx info (only show if no pending — avoids showing stale completed tx
    // while a new deposit is in progress)
    const latestDecimals = getDecimals(latest?.tokenIn);
    const latestAmount   = humanAmount(latest?.amountIn, latestDecimals);

    res.json({
      vaultAddress,
      network: NETWORK_LABEL,
      explorerTx: EXPLORER_TX,
      pending: pending
        ? {
            token:     pending.tokenSymbol ?? "TOKEN",
            amount:    pendingAmount,
            expiresAt: pending.expiresAt,
            tweetId:   pending.commentId ?? null,
          }
        : null,
      completed: !pending && latest
        ? {
            txHash: latest.txHash,
            amount: latestAmount,
            status: latest.status,
          }
        : null,
    });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/c/:b64
 * Short-link for launched tokens — decodes base64url address, redirects to Clanker.
 * Used in tweets so no raw 0x address appears (prevents X auto-ban).
 */
router.get("/c/:b64", (req, res) => {
  try {
    const hex          = Buffer.from(req.params["b64"]!, "base64url").toString("hex");
    const tokenAddress = `0x${hex}`;
    res.redirect(302, `https://clanker.world/clanker/${tokenAddress}`);
  } catch {
    res.status(400).send("Invalid token link");
  }
});

export default router;
