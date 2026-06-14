import { Router } from "express";
import { db, usersTable, mcpPendingTable } from "@workspace/db";
import { ilike, eq, and } from "drizzle-orm";
import { readVaultBalance, deployVault, getVaultByGithubId } from "../lib/relayer";
import { buildSendCallsPayload } from "../lib/send-calls";
import { generateKeypair, encryptPrivateKey } from "../lib/key-engine";
import { resolveToken, getAllTokens } from "../lib/tokens";
import { isAddress, type Address } from "viem";
import crypto from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const router = Router();

const CONFIRM_URL = "https://github.com/gitbankio/playground/discussions/4#new_comment_form";

router.get("/public/plugin/download", (_req, res) => {
  try {
    const pluginPath = join(dirname(fileURLToPath(import.meta.url)), "../../../base-plugin/gitbank-base-mcp-plugin.md");
    const file = readFileSync(pluginPath, "utf-8");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="gitbank-base-mcp-plugin.txt"');
    res.send(file);
  } catch {
    res.status(404).json({ error: "Plugin spec not found" });
  }
});

router.get("/public/plugin/download-relayer", (_req, res) => {
  try {
    const pluginPath = join(dirname(fileURLToPath(import.meta.url)), "../plugins/gitbank-relayer-plugin.md");
    const file = readFileSync(pluginPath, "utf-8");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="gitbank-relayer-plugin.txt"');
    res.send(file);
  } catch {
    res.status(404).json({ error: "Plugin spec not found" });
  }
});

// ── Rate limiter: max 10 prepare requests per IP per 10 minutes ───────────────
const prepareRateMap = new Map<string, { count: number; resetAt: number }>();
const PREPARE_LIMIT = 10;
const PREPARE_WINDOW_MS = 10 * 60 * 1000;

function checkPrepareRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = prepareRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    prepareRateMap.set(ip, { count: 1, resetAt: now + PREPARE_WINDOW_MS });
    return true;
  }
  if (entry.count >= PREPARE_LIMIT) return false;
  entry.count++;
  return true;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function getVaultBalances(vaultAddress: Address) {
  const tokens = getAllTokens().filter((t) => ["USDC", "WETH"].includes(t.symbol));
  const results: Record<string, string> = {};
  await Promise.all(
    tokens.map(async (t) => {
      try {
        const raw = await readVaultBalance(vaultAddress, t.address);
        results[t.symbol] = (Number(raw) / 10 ** t.decimals).toFixed(t.decimals <= 6 ? 2 : 6);
      } catch {
        results[t.symbol] = "0";
      }
    }),
  );
  return results;
}

async function lookupUserByUsername(username: string) {
  const rows = await db
    .select()
    .from(usersTable)
    .where(ilike(usersTable.githubLogin, username))
    .limit(1);
  return rows[0] ?? null;
}

function generateConfirmCode(): string {
  return "mcp" + crypto.randomBytes(4).toString("hex");
}

async function createPendingRecord(
  username: string,
  command: string,
  params: Record<string, unknown>,
  executionMode: "relayer" | "send_calls" = "relayer",
): Promise<string> {
  const confirmCode = generateConfirmCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.insert(mcpPendingTable).values({
    githubUsername: username,
    command,
    params,
    confirmCode,
    status: "pending",
    expiresAt,
    executionMode,
  });
  return confirmCode;
}

function confirmMsg(code: string, summary: string, username: string): string {
  return (
    `${summary}\n\n` +
    `To authorize, open:\n${CONFIRM_URL}\n\n` +
    `And post this comment:\n@gitbankbot confirm ${code}\n\n` +
    `(Expires in 10 minutes. Only @${username} can confirm it.)`
  );
}

// ── Auto-deploy vault helper ──────────────────────────────────────────────────
// Called by all three prepare endpoints.
// - If user unknown locally: fetch from GitHub API and create a DB record.
// - If user has no keypair: generate one and save.
// - If user has no vault: deploy via relayer (deployer pays gas), poll until confirmed.
// Returns the fully-populated user row (vaultAddress guaranteed set), or null if
// the GitHub username does not exist.
// Throws an Error (with a user-readable message) on deployment failure.

type UserRow = typeof usersTable.$inferSelect;

async function getOrDeployVaultUser(username: string): Promise<UserRow | null> {
  let user = await lookupUserByUsername(username);

  // Not in DB yet — verify on GitHub and create a skeleton record
  if (!user) {
    const headers: Record<string, string> = { "User-Agent": "Gitbank" };
    const pat = process.env["GITHUB_PAT"];
    if (pat) headers["Authorization"] = `Bearer ${pat}`;

    const ghRes = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}`,
      { headers },
    );
    if (ghRes.status === 404) return null;
    if (!ghRes.ok) throw new Error(`GitHub API error: ${ghRes.status}`);

    const ghUser = await ghRes.json() as { id: number; login: string };

    await db
      .insert(usersTable)
      .values({ githubId: ghUser.id, githubLogin: ghUser.login, role: "member" })
      .onConflictDoNothing();

    user = await lookupUserByUsername(ghUser.login);
    if (!user) throw new Error("Failed to create user record");
  }

  // Has a record but no keypair yet — generate one
  if (!user.encryptedPk) {
    const kp = generateKeypair();
    const encPk = encryptPrivateKey(kp.privateKey);
    await db
      .update(usersTable)
      .set({ ownerAddress: kp.address, encryptedPk: encPk })
      .where(eq(usersTable.githubId, user.githubId));
    user = { ...user, ownerAddress: kp.address, encryptedPk: encPk };
  }

  // Has keypair but no vault — deploy on-chain (deployer pays gas)
  if (!user.vaultAddress) {
    await deployVault(
      user.encryptedPk!,
      BigInt(user.githubId),
      user.ownerAddress as Address,
    );

    // Poll until vault address resolves (Base ~2s blocks, max ~30s)
    let vaultAddress: string | null = null;
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => setTimeout(r, 3000));
      try {
        const addr = await getVaultByGithubId(BigInt(user.githubId));
        if (addr && addr !== "0x0000000000000000000000000000000000000000") {
          vaultAddress = addr;
          break;
        }
      } catch { /* keep polling */ }
    }

    if (!vaultAddress) {
      throw new Error(
        "Vault deploy submitted but address is taking longer than expected. " +
        "Try again in 30 seconds.",
      );
    }

    await db
      .update(usersTable)
      .set({ vaultAddress })
      .where(eq(usersTable.githubId, user.githubId));
    user = { ...user, vaultAddress };
  }

  return user;
}

// ── GET /api/public/vault/by-github/:username ─────────────────────────────────

router.get("/public/vault/by-github/:username", async (req, res) => {
  try {
    const username = req.params["username"]?.toLowerCase() ?? "";
    if (!username) { res.status(400).json({ error: "username required" }); return; }

    let user = await lookupUserByUsername(username);

    // Not in our DB — check GitHub to return a useful "not yet deployed" instead of 404
    if (!user) {
      const headers: Record<string, string> = { "User-Agent": "Gitbank" };
      const pat = process.env["GITHUB_PAT"];
      if (pat) headers["Authorization"] = `Bearer ${pat}`;
      const ghRes = await fetch(
        `https://api.github.com/users/${encodeURIComponent(username)}`,
        { headers },
      );
      if (ghRes.status === 404) {
        res.status(404).json({ error: "GitHub user not found. Check the username." });
        return;
      }
      if (ghRes.ok) {
        const ghUser = await ghRes.json() as { id: number; login: string };
        res.json({
          github_username: ghUser.login,
          vault_deployed: false,
          balances: {},
          note: "No vault deployed yet. It will be created automatically on the first prepare request.",
        });
        return;
      }
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (!user.vaultAddress) {
      res.json({ github_username: user.githubLogin, vault_deployed: false, balances: {} });
      return;
    }

    const balances = await getVaultBalances(user.vaultAddress as Address);
    res.json({
      github_username: user.githubLogin,
      vault_address: user.vaultAddress,
      vault_deployed: true,
      balances,
      chain: "base",
      chain_id: 8453,
    });
  } catch (err) {
    req.log.error({ err }, "public/vault/by-github error");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── GET /api/public/vault/:vault_address ──────────────────────────────────────

router.get("/public/vault/:vault_address", async (req, res) => {
  try {
    const vaultAddress = req.params["vault_address"] ?? "";
    if (!isAddress(vaultAddress)) { res.status(400).json({ error: "Invalid vault address" }); return; }

    const balances = await getVaultBalances(vaultAddress as Address);
    res.json({ vault_address: vaultAddress, balances, chain: "base", chain_id: 8453 });
  } catch (err) {
    req.log.error({ err }, "public/vault error");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── GET /api/public/prepare/deposit ──────────────────────────────────────────
// Query params: username, amount, token (USDC|WETH)
// Auto-deploys vault if user has none. Queues a pending deposit and returns a
// GitHub confirm code. No calldata signed until user confirms on GitHub.

router.get("/public/prepare/deposit", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? "unknown";
    if (!checkPrepareRateLimit(ip)) {
      res.status(429).json({ error: "Too many prepare requests. Try again in 10 minutes." });
      return;
    }
    const { username, amount, token } = req.query as Record<string, string>;
    if (!username || !amount || !token) {
      res.status(400).json({ error: "username, amount, and token are required" });
      return;
    }

    const tokenInfo = resolveToken(token);
    if (!tokenInfo) { res.status(400).json({ error: "Unsupported token. Use USDC or WETH" }); return; }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      res.status(400).json({ error: "amount must be a positive number" });
      return;
    }

    const user = await getOrDeployVaultUser(username);
    if (!user) {
      res.status(404).json({ error: "GitHub user not found. Check the username." });
      return;
    }

    const mode = (req.query["mode"] as string) === "send_calls" ? "send_calls" : "relayer";
    const confirmCode = await createPendingRecord(user.githubLogin, "deposit", {
      token: tokenInfo.symbol,
      amount: parsedAmount,
    }, mode);

    const summary = `Deposit ${parsedAmount} ${tokenInfo.symbol} into @${user.githubLogin}'s vault queued.`;
    res.json({
      ok: true,
      command: "deposit",
      username: user.githubLogin,
      vault_address: user.vaultAddress,
      amount: parsedAmount,
      token: tokenInfo.symbol,
      execution_mode: mode,
      confirm_code: confirmCode,
      instructions: confirmMsg(confirmCode, summary, user.githubLogin),
      confirm_url: CONFIRM_URL,
      expires_in_seconds: 600,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    req.log.error({ err }, "public/prepare/deposit error");
    res.status(503).json({ error: msg });
  }
});

// ── GET /api/public/prepare/withdraw ─────────────────────────────────────────
// Query params: username, amount, token (USDC|WETH), to (destination address)

router.get("/public/prepare/withdraw", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? "unknown";
    if (!checkPrepareRateLimit(ip)) {
      res.status(429).json({ error: "Too many prepare requests. Try again in 10 minutes." });
      return;
    }
    const { username, amount, token, to } = req.query as Record<string, string>;
    if (!username || !amount || !token || !to) {
      res.status(400).json({ error: "username, amount, token, and to are required" });
      return;
    }
    if (!isAddress(to)) { res.status(400).json({ error: "Invalid destination address" }); return; }

    const tokenInfo = resolveToken(token);
    if (!tokenInfo) { res.status(400).json({ error: "Unsupported token. Use USDC or WETH" }); return; }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      res.status(400).json({ error: "amount must be a positive number" });
      return;
    }

    const user = await getOrDeployVaultUser(username);
    if (!user) {
      res.status(404).json({ error: "GitHub user not found. Check the username." });
      return;
    }

    const mode = (req.query["mode"] as string) === "send_calls" ? "send_calls" : "relayer";
    const confirmCode = await createPendingRecord(user.githubLogin, "withdraw", {
      token: tokenInfo.symbol,
      amount: parsedAmount,
      to_address: to,
    }, mode);

    const dest = `${to.slice(0, 6)}...${to.slice(-4)}`;
    const summary = `Withdraw ${parsedAmount} ${tokenInfo.symbol} from @${user.githubLogin}'s vault to ${dest} queued.`;
    res.json({
      ok: true,
      command: "withdraw",
      username: user.githubLogin,
      vault_address: user.vaultAddress,
      amount: parsedAmount,
      token: tokenInfo.symbol,
      to,
      execution_mode: mode,
      confirm_code: confirmCode,
      instructions: confirmMsg(confirmCode, summary, user.githubLogin),
      confirm_url: CONFIRM_URL,
      expires_in_seconds: 600,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    req.log.error({ err }, "public/prepare/withdraw error");
    res.status(503).json({ error: msg });
  }
});

// ── GET /api/public/prepare/swap ──────────────────────────────────────────────
// Query params: username, amount, from_token, to_token

router.get("/public/prepare/swap", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? "unknown";
    if (!checkPrepareRateLimit(ip)) {
      res.status(429).json({ error: "Too many prepare requests. Try again in 10 minutes." });
      return;
    }
    const { username, amount, from_token, to_token } = req.query as Record<string, string>;
    if (!username || !amount || !from_token || !to_token) {
      res.status(400).json({ error: "username, amount, from_token, and to_token are required" });
      return;
    }

    const tokenIn = resolveToken(from_token);
    const tokenOut = resolveToken(to_token);
    if (!tokenIn) { res.status(400).json({ error: "Unsupported from_token. Use USDC or WETH" }); return; }
    if (!tokenOut) { res.status(400).json({ error: "Unsupported to_token. Use USDC or WETH" }); return; }
    if (tokenIn.symbol === tokenOut.symbol) {
      res.status(400).json({ error: "from_token and to_token must differ" });
      return;
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      res.status(400).json({ error: "amount must be a positive number" });
      return;
    }

    const user = await getOrDeployVaultUser(username);
    if (!user) {
      res.status(404).json({ error: "GitHub user not found. Check the username." });
      return;
    }

    const mode = (req.query["mode"] as string) === "send_calls" ? "send_calls" : "relayer";
    const confirmCode = await createPendingRecord(user.githubLogin, "swap", {
      from_token: tokenIn.symbol,
      to_token: tokenOut.symbol,
      amount: parsedAmount,
    }, mode);

    const summary = `Swap ${parsedAmount} ${tokenIn.symbol} to ${tokenOut.symbol} in @${user.githubLogin}'s vault queued.`;
    res.json({
      ok: true,
      command: "swap",
      username: user.githubLogin,
      vault_address: user.vaultAddress,
      amount: parsedAmount,
      from_token: tokenIn.symbol,
      to_token: tokenOut.symbol,
      execution_mode: mode,
      confirm_code: confirmCode,
      instructions: confirmMsg(confirmCode, summary, user.githubLogin),
      confirm_url: CONFIRM_URL,
      expires_in_seconds: 600,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    req.log.error({ err }, "public/prepare/swap error");
    res.status(503).json({ error: msg });
  }
});

// ── GET /api/public/pending/:confirm_code ─────────────────────────────────────
// Poll the status of a pending command by confirm code. Used by the relayer plugin
// so AI assistants without MCP can check execution status after GitHub confirmation.

router.get("/public/pending/:confirm_code", async (req, res) => {
  try {
    const { confirm_code } = req.params as { confirm_code: string };
    if (!confirm_code) {
      res.status(400).json({ error: "confirm_code is required" });
      return;
    }

    const [row] = await db.select().from(mcpPendingTable)
      .where(eq(mcpPendingTable.confirmCode, confirm_code)).limit(1);

    if (!row) {
      res.status(404).json({ error: "Confirm code not found" });
      return;
    }

    let txHash: string | undefined;
    let basescan: string | undefined;

    if (row.resultText) {
      const txMatch = row.resultText.match(/tx_hash:\s*(0x[a-fA-F0-9]+)/);
      const bsMatch  = row.resultText.match(/basescan:\s*(https:\/\/[^\s]+)/);
      if (txMatch) txHash = txMatch[1];
      if (bsMatch)  basescan = bsMatch[1];
    }

    const isExpired = row.status === "pending" && new Date() > row.expiresAt;

    res.json({
      ok: true,
      confirm_code: row.confirmCode,
      command: row.command,
      username: row.githubUsername,
      status: isExpired ? "expired" : row.status,
      result: row.resultText ?? undefined,
      tx_hash: txHash,
      basescan: basescan,
    });
  } catch (err) {
    req.log.error({ err }, "public/pending error");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── GET /api/public/execute/:token ────────────────────────────────────────────
// Called by the AI after the user posts a GitHub confirm in send_calls mode.
// Returns the pre-signed EIP-5792 calls array for wallet_sendCalls.
// Token is single-use and expires 10 minutes after generation.

router.get("/public/execute/:token", async (req, res) => {
  try {
    const { token } = req.params as { token: string };
    if (!token || !token.startsWith("exec")) {
      res.status(400).json({ error: "Invalid execute token format" });
      return;
    }

    // Atomic claim: single UPDATE WHERE status='ready_to_execute' eliminates TOCTOU.
    // Two simultaneous requests cannot both succeed — only the one that updates a row wins.
    const claimed = await db.update(mcpPendingTable)
      .set({ status: "dispatched" })
      .where(and(
        eq(mcpPendingTable.executeToken, token),
        eq(mcpPendingTable.status, "ready_to_execute"),
      ))
      .returning();

    if (claimed.length === 0) {
      // Token missing, wrong status (expired/dispatched/etc), or race-lost.
      // Look up to give the best error message.
      const [existing] = await db.select().from(mcpPendingTable)
        .where(eq(mcpPendingTable.executeToken, token)).limit(1);
      if (!existing) {
        res.status(404).json({ error: "Execute token not found" });
      } else if (existing.status === "dispatched") {
        res.status(410).json({ error: "Execute token already claimed (single-use)" });
      } else if (!existing.executeTokenExpiresAt || new Date() > existing.executeTokenExpiresAt) {
        res.status(410).json({ error: "Execute token expired. Run the prepare request again." });
      } else {
        res.status(400).json({ error: `Token is in unexpected status: '${existing.status}'` });
      }
      return;
    }

    const record = claimed[0]!;

    // Guard: double-check expiry even though atomic UPDATE won (clock edge case)
    if (!record.executeTokenExpiresAt || new Date() > record.executeTokenExpiresAt) {
      await db.update(mcpPendingTable).set({ status: "expired" })
        .where(eq(mcpPendingTable.executeToken, token));
      res.status(410).json({ error: "Execute token expired. Run the prepare request again." });
      return;
    }

    const payload = record.executeCalldata as { calls: Array<{ to: string; data: string; value: string }> };

    res.json({
      ok: true,
      command: record.command,
      username: record.githubUsername,
      chain_id: 8453,
      chain_id_hex: "0x2105",
      calls: payload.calls,
      note: "Pass 'calls' to wallet_sendCalls (EIP-5792) via Base MCP. Transaction will be submitted from your Base Account.",
    });
  } catch (err) {
    req.log.error({ err }, "public/execute error");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
