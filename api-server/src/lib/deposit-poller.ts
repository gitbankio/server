import { db, usersTable, xUsersTable, pendingDepositsTable, transactionsTable } from "@workspace/db";
import { eq, lte, isNotNull } from "drizzle-orm";
import { type Address } from "viem";
import { lockDeposit, readVaultAvailableDeposit, readErc20Balance, readVaultNonce } from "./relayer";
import { logger } from "./logger";
import { getInstallationToken } from "./github-app";
import { postThread } from "./x-client";
import { resolveToken } from "./tokens";

const POLL_INTERVAL_MS        = 15_000;
const REWARD_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const REWARD_MIN_WEI          = 10_000_000_000_000n; // 0.00001 WETH — skip dust

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

  logger.info({ count: pending.length }, "deposit-poller: checking pending deposits");

  // Track vaults that have already had a shield executed this cycle.
  // Only one shield per vault per cycle to prevent nonce collision.
  // A vault is only added AFTER lockDeposit succeeds — not before balance checks —
  // so that an insufficient-balance record for one token doesn't block another token
  // for the same vault from being processed in the same cycle.
  const processedVaults = new Set<string>();

  for (const record of pending) {
    if (processedVaults.has(record.trackingAddress)) continue;
    try {
      const tokenAddress   = record.token as Address;
      const vaultAddress   = record.trackingAddress as Address;
      const amountExpected = BigInt(record.amountExpected ?? "0");

      const available = await readAvailable(vaultAddress, tokenAddress);

      logger.info(
        { id: record.id, vaultAddress, token: record.tokenSymbol, available: available.toString(), amountExpected: amountExpected.toString() },
        "deposit-poller: balance check",
      );

      // amountExpected=0 means "shield any incoming balance"
      if (amountExpected === 0n) {
        if (available === 0n) {
          logger.info({ id: record.id }, "deposit-poller: no balance yet, skipping");
          continue; // nothing arrived yet
        }
      } else {
        if (available < amountExpected) {
          logger.info({ id: record.id, available: available.toString(), amountExpected: amountExpected.toString() }, "deposit-poller: insufficient balance, skipping");
          continue; // not enough yet
        }
      }

      // Amount to actually shield: specific amount requested, or all available
      const shieldAmount = amountExpected > 0n ? amountExpected : available;

      // Resolve user: X deposits use xUsersTable, GitHub deposits use usersTable
      let encryptedPk: string | null = null;
      let ownerId: bigint = 0n;

      if (record.repo === "x-bot") {
        // X-bot flow: look up by xUserId (new records) or vaultAddress (legacy records)
        const xRows = record.xUserId
          ? await db.select().from(xUsersTable).where(eq(xUsersTable.xUserId, record.xUserId)).limit(1)
          : await db.select().from(xUsersTable).where(eq(xUsersTable.vaultAddress, vaultAddress)).limit(1);
        const xUser = xRows[0];
        if (!xUser?.encryptedPk || !xUser.vaultAddress) {
          logger.warn({ vaultAddress, xUserId: record.xUserId }, "deposit-poller: xUser not found, skipping");
          continue;
        }
        encryptedPk = xUser.encryptedPk;
        ownerId = BigInt(xUser.xUserId);
      } else {
        // GitHub flow: look up by githubId (never a Twitter ID, always safe as number)
        const userRows = await db.select().from(usersTable)
          .where(eq(usersTable.githubId, record.githubId!)).limit(1);
        const user = userRows[0];
        if (!user?.encryptedPk || !user.vaultAddress) continue;
        encryptedPk = user.encryptedPk;
        ownerId = BigInt(record.githubId!);
      }

      const nonce = await readVaultNonce(vaultAddress);
      const result = await lockDeposit(
        encryptedPk,
        vaultAddress,
        ownerId,
        tokenAddress,
        shieldAmount,
        nonce,
      );

      // Mark vault as having a shield in-flight this cycle — only after a successful
      // lockDeposit call. This prevents a second token for the same vault from being
      // shielded in the same cycle (which would collide on the incremented nonce).
      processedVaults.add(vaultAddress);

      await db.insert(transactionsTable).values({
        type: "lock",
        githubId: Number(ownerId),
        tokenIn: record.token,
        amountIn: shieldAmount.toString(),
        txHash: result.txHash,
        status: "pending",
      });

      await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.id, record.id));

      const decimals = (record.tokenSymbol ?? "USDC") === "USDC" ? 6 : 18;
      const amountHuman = (Number(shieldAmount) / 10 ** decimals).toFixed(decimals === 6 ? 2 : 6);

      if (record.repo === "x-bot" && record.senderLogin && record.commentId) {
        const b64 = Buffer.from(result.txHash.slice(2), "hex").toString("base64url");
        const txUrl    = `https://gitbank.io/api/t/${b64}`;
        const vaultUrl = `https://gitbank.io/v/${record.githubId}?tweet=${record.commentId}`;
        // Reply to the original X thread with receipt
        await postThread(
          `@${record.senderLogin} Deposit confirmed.\n` +
          `Tx: ...${result.txHash.slice(-10)}\n` +
          `${txUrl}\n` +
          `${amountHuman} ${record.tokenSymbol ?? "TOKEN"} locked in vault.\n` +
          `${vaultUrl}\n` +
          `Network: ${process.env["BASE_NETWORK"] === "mainnet" ? "Base Mainnet" : "Base Sepolia"} | Gas: Gitbank Relayer`,
          record.commentId,
        );
      } else if (record.repo && record.repo !== "x-bot" && record.issueNumber && record.installationId && record.senderLogin) {
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

// ── Auto-shield Clanker reward WETH ───────────────────────────────────────────
// Every 10 minutes: scan all X-bot vaults, auto-shield any unshielded WETH
// that arrived from Clanker LP fee distribution.

async function processRewardAutoShields(): Promise<void> {
  const weth = resolveToken("WETH");
  if (!weth) return;

  // Only xUsers with a deployed vault and keypair
  const xUsers = await db
    .select()
    .from(xUsersTable)
    .where(isNotNull(xUsersTable.vaultAddress));

  const eligible = xUsers.filter(u => u.vaultAddress && u.encryptedPk && u.xUserId);
  if (eligible.length === 0) return;

  logger.info({ count: eligible.length }, "reward-shield: scanning vaults");

  for (const xUser of eligible) {
    try {
      const vault     = xUser.vaultAddress as Address;
      const available = await readAvailable(vault, weth.address);

      if (available < REWARD_MIN_WEI) continue;

      logger.info(
        { vault, availableWei: available.toString(), xUserId: xUser.xUserId },
        "reward-shield: unshielded WETH found, auto-shielding",
      );

      if (!xUser.encryptedPk) continue;
      const nonce  = await readVaultNonce(vault);
      const xId    = BigInt(xUser.xUserId);
      const result = await lockDeposit(xUser.encryptedPk, vault, xId, weth.address, available, nonce);

      await db.insert(transactionsTable).values({
        type:     "lock",
        githubId: Number(xId),
        tokenIn:  weth.address,
        amountIn: available.toString(),
        txHash:   result.txHash,
        status:   "pending",
      });

      const amountHuman = (Number(available) / 1e18).toFixed(6);

      // Notify user on X as reply to nothing (standalone mention)
      await postThread(
        `@${xUser.xUsername} Auto-shielded ${amountHuman} gitWETH rewards into your vault.\n` +
        `Tx: ...${result.txHash.slice(-10)}\n` +
        `${EXPLORER}/${result.txHash}`,
      );

      logger.info(
        { txHash: result.txHash, xUserId: xUser.xUserId, amountHuman },
        "reward-shield: done",
      );
    } catch (err) {
      logger.warn({ err, xUserId: xUser.xUserId }, "reward-shield: failed, skipping");
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

  // Auto-shield Clanker WETH rewards — run immediately then every 10 min
  void processRewardAutoShields().catch(err =>
    logger.warn({ err }, "reward-shield: initial scan failed"),
  );
  setInterval(() => {
    processRewardAutoShields().catch(err =>
      logger.warn({ err }, "reward-shield: unhandled error"),
    );
  }, REWARD_POLL_INTERVAL_MS);
}
