import { Router } from "express";
import { db, contestEntriesTable, usersTable } from "@workspace/db";
import { eq, count, sql } from "drizzle-orm";
import {
  deployVault,
  getVaultByGithubId,
  lockDeposit,
  readVaultNonce,
  sendErc20FromDeployer,
} from "../lib/relayer";
import { generateKeypair, encryptPrivateKey } from "../lib/key-engine";
import { resolveToken } from "../lib/tokens";
import { randomUUID } from "crypto";
import type { Address } from "viem";

const router = Router();

const CONTEST_AMOUNT_USDC = 5n * 1_000_000n;
const MAX_ENTRIES = 100;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function isValidAddress(s: unknown): s is Address {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll factory until vault address is confirmed on-chain.
 * Tries every 4 seconds for up to 90 seconds.
 */
async function waitForVault(githubId: bigint): Promise<Address> {
  for (let i = 0; i < 23; i++) {
    await sleep(4000);
    const addr = await getVaultByGithubId(githubId);
    if (addr && addr !== ZERO_ADDR) return addr as Address;
  }
  throw new Error("Vault not confirmed on-chain after 90s");
}

/**
 * Ensure the participant has a user record + vault in DB/on-chain.
 * Returns { encryptedPk, vaultAddress } ready for gitShield signing.
 *
 * Throws "ORPHANED_VAULT" if an on-chain vault exists but the DB keypair
 * doesn't match — should never happen for new participants.
 */
async function ensureVault(
  githubId: number,
  githubLogin: string,
): Promise<{ encryptedPk: string; vaultAddress: Address }> {
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.githubId, githubId))
    .limit(1);

  let user = existing[0];

  // ── Step 1: ensure user row + execution keypair ──────────────────────────
  if (!user) {
    // Before generating a fresh keypair, check whether an on-chain vault
    // already exists for this GH ID. If so, we cannot sign for it (orphaned).
    const onChain = await getVaultByGithubId(BigInt(githubId));
    if (onChain && onChain !== ZERO_ADDR) {
      throw new Error("ORPHANED_VAULT");
    }

    const { address: ownerAddress, privateKey } = generateKeypair();
    const encryptedPk = encryptPrivateKey(privateKey);
    await db.insert(usersTable).values({
      githubId,
      githubLogin,
      ownerAddress,
      encryptedPk,
    });
    user = (await db.select().from(usersTable).where(eq(usersTable.githubId, githubId)).limit(1))[0]!;
  } else if (!user.encryptedPk || !user.ownerAddress) {
    const { address: ownerAddress, privateKey } = generateKeypair();
    const encryptedPk = encryptPrivateKey(privateKey);
    await db.update(usersTable)
      .set({ ownerAddress, encryptedPk })
      .where(eq(usersTable.githubId, githubId));
    user = { ...user, ownerAddress, encryptedPk };
  }

  const { encryptedPk, ownerAddress } = user as { encryptedPk: string; ownerAddress: string };

  // ── Step 2: ensure vault is deployed ────────────────────────────────────
  if (!user.vaultAddress) {
    // Deploy vault via factory (deployer pays gas)
    await deployVault(encryptedPk, BigInt(githubId), ownerAddress as Address);

    // Poll until confirmed
    const vaultAddress = await waitForVault(BigInt(githubId));
    await db.update(usersTable)
      .set({ vaultAddress })
      .where(eq(usersTable.githubId, githubId));
    return { encryptedPk, vaultAddress };
  }

  return { encryptedPk, vaultAddress: user.vaultAddress as Address };
}

// ── POST /contest/pay ─────────────────────────────────────────────────────────
// Called by GitHub Actions after a template PR is merged.
// Deploys vault if needed, sends 5 USDC, then gitShield → 5 gitUSDC in vault.

router.post("/contest/pay", async (req, res) => {
  const secret = process.env["CONTEST_API_SECRET"];
  if (!secret) {
    req.log.warn("CONTEST_API_SECRET not configured");
    res.status(503).json({ error: "Hackathon payment not configured" });
    return;
  }

  const provided = req.headers["x-contest-secret"];
  if (!provided || provided !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { github_id, github_login, wallet, template_title, app_type, pr_number, pr_url } = req.body ?? {};

  if (!Number.isInteger(github_id) || github_id <= 0) { res.status(400).json({ error: "Invalid github_id" }); return; }
  if (typeof github_login !== "string" || !github_login) { res.status(400).json({ error: "Invalid github_login" }); return; }
  if (!isValidAddress(wallet)) { res.status(400).json({ error: "Invalid wallet address" }); return; }
  if (typeof template_title !== "string" || !template_title) { res.status(400).json({ error: "Invalid template_title" }); return; }
  if (typeof app_type !== "string" || !app_type) { res.status(400).json({ error: "Invalid app_type" }); return; }
  if (!Number.isInteger(pr_number) || pr_number <= 0) { res.status(400).json({ error: "Invalid pr_number" }); return; }
  if (typeof pr_url !== "string" || !pr_url.startsWith("https://")) { res.status(400).json({ error: "Invalid pr_url" }); return; }

  const usdc = resolveToken("USDC");
  if (!usdc) {
    req.log.error("USDC token not found in token list");
    res.status(503).json({ error: "USDC not available on current network" });
    return;
  }

  // ── Atomically claim a slot ───────────────────────────────────────────────
  let entryNumber!: number;
  let entryId: string;

  try {
    entryId = randomUUID();

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(20260525)`);

      const [existingEntry] = await tx
        .select()
        .from(contestEntriesTable)
        .where(eq(contestEntriesTable.githubId, github_id))
        .limit(1);

      if (existingEntry) {
        const err = new Error("DUPLICATE") as Error & { entryNumber: number };
        err.entryNumber = existingEntry.entryNumber;
        throw err;
      }

      const [{ value: total }] = await tx.select({ value: count() }).from(contestEntriesTable);
      if (total >= MAX_ENTRIES) throw new Error("FULL");

      entryNumber = total + 1;
      await tx.insert(contestEntriesTable).values({
        id: entryId,
        githubId: github_id,
        githubLogin: github_login,
        wallet,
        templateTitle: template_title,
        appType: app_type,
        prNumber: pr_number,
        prUrl: pr_url,
        entryNumber,
        status: "pending",
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "DUPLICATE") {
      const e = err as Error & { entryNumber?: number };
      req.log.warn({ github_id }, "Duplicate hackathon entry attempt");
      res.status(409).json({ error: "This GitHub account already has an accepted entry", entryNumber: e.entryNumber });
      return;
    }
    if (msg === "FULL") {
      res.status(409).json({ error: "The hackathon is full. All 100 slots have been filled." });
      return;
    }
    req.log.error({ err }, "Failed to claim hackathon slot");
    res.status(500).json({ error: "Failed to reserve entry slot" });
    return;
  }

  req.log.info({ github_login, entry_number: entryNumber }, "Hackathon entry claimed, deploying vault if needed");

  // ── Ensure vault exists (deploy on first use) ─────────────────────────────
  let encryptedPk: string;
  let vaultAddress: Address;

  try {
    ({ encryptedPk, vaultAddress } = await ensureVault(github_id, github_login));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, github_login }, "Vault ensure failed");
    await db.update(contestEntriesTable).set({ status: "failed" }).where(eq(contestEntriesTable.id, entryId!));
    if (msg === "ORPHANED_VAULT") {
      res.status(409).json({ error: "A vault already exists for this GitHub account from a previous session. Please contact support." });
    } else {
      res.status(500).json({ error: "Vault deployment failed" });
    }
    return;
  }

  req.log.info({ github_login, vaultAddress, entry_number: entryNumber }, "Vault ready, sending USDC then gitShield");

  // ── Transfer USDC to vault address, then gitShield ────────────────────────
  // Result: participant gets 5 gitUSDC in their vault (withdrawable as USDC)
  let txHash: string;
  try {
    // Step 1: send USDC from deployer to vault address
    await sendErc20FromDeployer(usdc.address, vaultAddress, CONTEST_AMOUNT_USDC);

    // Step 2: wait for ERC-20 transfer to land
    await sleep(6000);

    // Step 3: gitShield — lock balance into vault (becomes gitUSDC)
    const nonce = await readVaultNonce(vaultAddress);
    const shieldResult = await lockDeposit(
      encryptedPk,
      vaultAddress,
      BigInt(github_id),
      usdc.address,
      CONTEST_AMOUNT_USDC,
      nonce,
    );
    txHash = shieldResult.txHash;
  } catch (err) {
    req.log.error({ err, github_login }, "Hackathon gitShield failed");
    await db.update(contestEntriesTable).set({ status: "failed" }).where(eq(contestEntriesTable.id, entryId!));
    res.status(500).json({ error: "Payment transaction failed" });
    return;
  }

  await db.update(contestEntriesTable)
    .set({ status: "paid", txHash })
    .where(eq(contestEntriesTable.id, entryId!));

  req.log.info({ github_login, vaultAddress, txHash, entry_number: entryNumber }, "5 gitUSDC reward sent");
  res.json({ txHash, entryNumber, vaultAddress });
});

// ── GET /contest/entries ──────────────────────────────────────────────────────

router.get("/contest/entries", async (_req, res) => {
  const entries = await db
    .select()
    .from(contestEntriesTable)
    .orderBy(contestEntriesTable.entryNumber);
  res.json(entries);
});

export default router;
