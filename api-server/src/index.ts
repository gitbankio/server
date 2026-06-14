import app from "./app";
import { logger } from "./lib/logger";
import { startDepositPoller } from "./lib/deposit-poller";
import { startTxConfirmer } from "./lib/tx-confirmer";
import { seedLaunchedTokens } from "./lib/seed";
import { startXPoller } from "./lib/x-poller";
import { db, mcpPendingTable } from "@workspace/db";
import { lte } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  void seedLaunchedTokens();

  // Clean up expired mcp_pending_commands every 15 minutes
  setInterval(async () => {
    try {
      const deleted = await db.delete(mcpPendingTable).where(lte(mcpPendingTable.expiresAt, new Date()));
      logger.debug({ deleted }, "mcp-pending cleanup: expired records removed");
    } catch (err) {
      logger.warn({ err }, "mcp-pending cleanup failed");
    }
  }, 15 * 60 * 1000);

  if (process.env["NODE_ENV"] === "production") {
    startDepositPoller();
    startTxConfirmer();
    startXPoller();
  } else {
    logger.info("Workers disabled in non-production environment");
  }
});
