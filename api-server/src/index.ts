import app from "./app";
import { logger } from "./lib/logger";
import { startDepositPoller } from "./lib/deposit-poller";
import { startTxConfirmer } from "./lib/tx-confirmer";
import { seedLaunchedTokens } from "./lib/seed";

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

  if (process.env["NODE_ENV"] === "production") {
    startDepositPoller();
    startTxConfirmer();
  } else {
    logger.info("Workers disabled in non-production environment");
  }
});
