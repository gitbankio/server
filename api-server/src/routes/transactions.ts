import { Router } from "express";
import { db, transactionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/transactions", requireAuth, async (req, res) => {
  try {
    const limitParam = req.query["limit"];
    const offsetParam = req.query["offset"];
    const projectIdParam = req.query["projectId"];

    const limit = limitParam ? Math.min(parseInt(limitParam as string, 10), 100) : 50;
    const offset = offsetParam ? parseInt(offsetParam as string, 10) : 0;

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.githubId, req.session.githubId!))
      .orderBy(desc(transactionsTable.createdAt))
      .limit(limit)
      .offset(offset);

    res.json(rows.map((tx) => ({
      id: tx.id,
      type: tx.type,
      githubId: tx.githubId,
      tokenIn: tx.tokenIn ?? null,
      tokenOut: tx.tokenOut ?? null,
      amountIn: tx.amountIn ?? null,
      amountOut: tx.amountOut ?? null,
      feeAmount: tx.feeAmount ?? null,
      txHash: tx.txHash ?? null,
      status: tx.status,
      blockNumber: tx.blockNumber ?? null,
      projectDbId: tx.projectDbId ?? null,
      taskDbId: tx.taskDbId ?? null,
      createdAt: tx.createdAt.toISOString(),
    })));
  } catch (err) {
    req.log.error({ err }, "GET /transactions error");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
