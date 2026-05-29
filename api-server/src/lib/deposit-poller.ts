import { db, usersTable, pendingDepositsTable, transactionsTable } from "@workspace/db";
import { eq, lte } from "drizzle-orm";
import { type Address } from "viem";
import { lockDeposit, readVaultAvailableDeposit, readErc20Balance, readVaultNonce } from "./relayer";
import { logger } from "./logger";
import { getInstallationToken } from "./github-app";

const POLL_INTERVAL_MS = 15_000;

const EXPLORER = process.env["BASE_NETWORK"] === "mainnet"
  ? "https://basescan.org/tx"
  : "https://sepolia.basescan.org/tx";

/**
 * Update an existing GitHub comment (or post new one if no commentId).
 * Discussion comment node IDs start with "DC_" → use GraphQL updateDiscussionComment.
 * Issue comment IDs are numeric strings → use REST PATCH.
 */
async function notifyReceipt(
  repo: string,
  issueNumber: number,
  installationId: number,
  senderLogin: string,
  txHash: string,
  amount: string,
  symbol: string,
  commentId: string | null | undefined,
): Promise<void> {
  if (process.env["NODE_ENV"] !== "production") {
    logger.info({ repo, issueNumber, txHash }, "[DEV] would update deposit receipt (skipped)");
    return;
  }
  try {
    const token = await getInstallationToken(installationId);
    const body =
      `@${senderLogin} Deposit confirmed and locked into your vault.\n\n` +
      "```\n" +
      `Token   : ${amount} git${symbol}\n` +
      `Tx hash : ${txHash}\n` +
      "```\n" +
      `[View on Basescan](${EXPLORER}/${txHash})`;

    if (commentId) {
      // Discussion comment node IDs start with "DC_"
      if (commentId.startsWith("DC_")) {
        await fetch("https://api.github.com/graphql", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "Gitbank",
          },
          body: JSON.stringify({
            query: `mutation($id:ID!,$body:String!){updateDiscussionComment(input:{commentId:$id,body:$body}){comment{id}}}`,
            variables: { id: commentId, body },
          }),
        });
      } else {
        const [owner, repoName] = repo.split("/");
        await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/comments/${commentId}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "Gitbank",
          },
          body: JSON.stringify({ body }),
        });
      }
    } else {
      // No commentId — fall back to posting a new comment
      const [owner, repoName] = repo.split("/");
      await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "Gitbank",
        },
        body: JSON.stringify({ body }),
      });
    }
  } catch (err) {
    logger.warn({ err }, "deposit-poller: failed to notify receipt");
  }
}

/**
 * Read how many tokens are sitting in the vault waiting to be shielded.
 * Tries vault.getAvailableDeposit() first (v3+ vaults).
 * Falls back to raw ERC-20 balanceOf(vault) for old vaults that lack the function.
 */
async function readAvailable(vaultAddress: Address, tokenAddress: Address): Promise<bigint> {
  try {
    return await readVaultAvailableDeposit(vaultAddress, tokenAddress);
  } catch {
    logger.info({ vaultAddress }, "deposit-poller: getAvailableDeposit not available, falling back to ERC20 balanceOf");
    return readErc20Balance(tokenAddress, vaultAddress);
  }
}

async function processPendingDeposits(): Promise<void> {
  const now = new Date();

  await db.delete(pendingDepositsTable).where(lte(pendingDepositsTable.expiresAt, now));

  const pending = await db.select().from(pendingDepositsTable);
  if (pending.length === 0) return;

  for (const record of pending) {
    try {
      const tokenAddress = record.token as Address;
      const vaultAddress = record.trackingAddress as Address;
      const amountExpected = BigInt(record.amountExpected ?? "0");

      if (amountExpected === 0n) continue;

      const available = await readAvailable(vaultAddress, tokenAddress);
      if (available < amountExpected) continue;

      const userRows = await db.select().from(usersTable)
        .where(eq(usersTable.githubId, record.githubId)).limit(1);
      const user = userRows[0];
      if (!user?.encryptedPk || !user.vaultAddress) continue;

      const nonce = await readVaultNonce(vaultAddress);
      const result = await lockDeposit(
        user.encryptedPk,
        vaultAddress,
        BigInt(user.githubId),
        tokenAddress,
        amountExpected,
        nonce,
      );

      await db.insert(transactionsTable).values({
        type: "lock",
        githubId: record.githubId,
        tokenIn: record.token,
        amountIn: amountExpected.toString(),
        txHash: result.txHash,
        status: "pending",
      });

      await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.id, record.id));

      if (record.repo && record.issueNumber && record.installationId && record.senderLogin) {
        const decimals = (record.tokenSymbol ?? "USDC") === "USDC" ? 6 : 18;
        const amountHuman = (Number(amountExpected) / 10 ** decimals).toString();
        await notifyReceipt(
          record.repo,
          record.issueNumber,
          record.installationId,
          record.senderLogin,
          result.txHash,
          amountHuman,
          record.tokenSymbol ?? "TOKEN",
          record.commentId,
        );
      }

      logger.info({ txHash: result.txHash, githubId: record.githubId }, "deposit-poller: auto-locked deposit");
    } catch (err) {
      logger.warn({ err, id: record.id }, "deposit-poller: failed to process record");
    }
  }
}

export function startDepositPoller(): void {
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "deposit-poller: started");
  setInterval(() => {
    processPendingDeposits().catch((err) =>
      logger.warn({ err }, "deposit-poller: unhandled error"),
    );
  }, POLL_INTERVAL_MS);
}
