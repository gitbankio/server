import { db, transactionsTable } from "@workspace/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { publicClient } from "./relayer";
import { logger } from "./logger";

const POLL_INTERVAL_MS = 15_000;
const MAX_RETRIES = 40; // ~10 minutes before giving up

async function confirmPendingTxs(): Promise<void> {
  // Get all pending txs that have a txHash
  const rows = await db
    .select()
    .from(transactionsTable)
    .where(and(eq(transactionsTable.status, "pending"), isNotNull(transactionsTable.txHash)));

  if (rows.length === 0) return;

  await Promise.allSettled(
    rows.map(async (tx) => {
      try {
        const receipt = await publicClient.getTransactionReceipt({
          hash: tx.txHash as `0x${string}`,
        });

        const newStatus = receipt.status === "success" ? "confirmed" : "failed";

        await db
          .update(transactionsTable)
          .set({
            status: newStatus,
            blockNumber: Number(receipt.blockNumber),
          })
          .where(eq(transactionsTable.id, tx.id));

        logger.info(
          { txHash: tx.txHash, status: newStatus, blockNumber: receipt.blockNumber.toString() },
          "tx-confirmer: tx finalized",
        );
      } catch {
        // Receipt not available yet -- tx still in mempool or not mined
        // Check age: if older than MAX_RETRIES * POLL_INTERVAL, mark failed
        const ageMs = Date.now() - new Date(tx.createdAt).getTime();
        if (ageMs > MAX_RETRIES * POLL_INTERVAL_MS) {
          await db
            .update(transactionsTable)
            .set({ status: "failed" })
            .where(eq(transactionsTable.id, tx.id));
          logger.warn({ txHash: tx.txHash, ageMs }, "tx-confirmer: tx timed out, marked failed");
        }
      }
    }),
  );
}

export function startTxConfirmer(): void {
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "tx-confirmer: started");
  // Run once immediately on startup to confirm any txs from a previous server session
  confirmPendingTxs().catch((err) => logger.warn({ err }, "tx-confirmer: startup check error"));
  setInterval(() => {
    confirmPendingTxs().catch((err) => logger.warn({ err }, "tx-confirmer: unhandled error"));
  }, POLL_INTERVAL_MS);
}
