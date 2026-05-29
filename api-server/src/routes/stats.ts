import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { commandLogTable } from "@workspace/db/schema";
import { transactionsTable } from "@workspace/db/schema";
import { installationsTable } from "@workspace/db/schema";
import { isNotNull, eq, count } from "drizzle-orm";
import { GetStatsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/stats", async (_req, res) => {
  const [vaults, commands, txs, repos] = await Promise.all([
    db.select({ n: count() }).from(usersTable).where(isNotNull(usersTable.vaultAddress)),
    db.select({ n: count() }).from(commandLogTable),
    db.select({ n: count() }).from(transactionsTable).where(eq(transactionsTable.status, "confirmed")),
    db.select({ n: count() }).from(installationsTable),
  ]);
  const data = GetStatsResponse.parse({
    vaultsDeployed: vaults[0]?.n ?? 0,
    commandsProcessed: commands[0]?.n ?? 0,
    txOnChain: txs[0]?.n ?? 0,
    reposConnected: repos[0]?.n ?? 0,
  });
  res.json(data);
});

export default router;
