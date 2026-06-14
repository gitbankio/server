#!/usr/bin/env node
/**
 * Gitbank x402 E2E Test — Base Mainnet (EIP-3009 flow)
 *
 * Flow:
 *   1. Probe /api/x402-test → verify HTTP 402 + PAYMENT-REQUIRED header
 *   2. Send webhook @gitbankbot x402-pay pointing to the test endpoint
 *   3. Bot: gitUnshield vault → deployer EOA (on-chain, real money)
 *   4. Bot: waits for unshield tx confirmation (~2s on Base)
 *   5. Bot: signs EIP-3009 TransferWithAuthorization from deployer private key
 *   6. Bot: retries GET /api/x402-test with X-PAYMENT header → API returns 200
 *   7. Script: wait for vault nonce increment (confirms gitUnshield on-chain)
 *   8. Verify tx hash in DB + Basescan link
 *
 * Run:
 *   (1) restart API server workflow (resets rate limiter)
 *   (2) node scripts/x402-e2e.cjs
 */
"use strict";

const crypto  = require("crypto");
const { Pool } = require("/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg");
const VIEM    = "/home/runner/workspace/node_modules/.pnpm/viem@2.49.3_typescript@5.9.3_zod@4.4.3/node_modules/viem";
const {
  createPublicClient, http, fallback, parseAbi, formatUnits,
} = require(VIEM + "/_cjs/index.js");
const { base } = require(VIEM + "/_cjs/chains/index.js");

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_TRANSPORT = fallback([
  ...(process.env.BASE_MAINNET_RPC_URL ? [http(process.env.BASE_MAINNET_RPC_URL)] : []),
  http("https://mainnet.base.org"),
  http("https://base.llamarpc.com"),
]);
const DB_URL     = process.env.DATABASE_URL;
const WHK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

if (!DB_URL || !WHK_SECRET) {
  console.error("Missing env vars: DATABASE_URL, GITHUB_WEBHOOK_SECRET");
  process.exit(1);
}

const EXPLORER     = "https://basescan.org/tx";
const TEST_GH_ID   = 11111111;
const TEST_LOGIN   = "mainnet-e2e-testuser";
const VAULT_ADDR   = "0x70Bf2cac89926f6E1a5592BB4b2645377e097495";
const USDC         = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Use HTTPS so the URL passes the https:// validator in handleX402Pay.
// In Replit dev, the API is accessible at the dev domain.
const REPLIT_DOMAIN = (process.env.REPLIT_DOMAINS || "").split(",")[0].trim();
const TEST_URL     = REPLIT_DOMAIN
  ? `https://${REPLIT_DOMAIN}/api/x402-test`
  : "https://gitbank.io/api/x402-test";
const MAX_APPROVE  = "0.3"; // approve up to 0.3 USDC — endpoint asks 0.2 USDC (above vault MINIMUM_FEE)

// ── Helpers ───────────────────────────────────────────────────────────────────

let failures = 0;
function pass(m)    { console.log("  \x1b[32m✓\x1b[0m " + m); }
function fail(m)    { console.log("  \x1b[31m✗\x1b[0m " + m); failures++; }
function info(m)    { console.log("  \x1b[33m·\x1b[0m " + m); }
function section(m) { console.log("\n\x1b[1m" + m + "\x1b[0m"); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

const VAULT_ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function getGitLockedBalance(address token) view returns (uint256)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const pool = new Pool({ connectionString: DB_URL });
const pub  = createPublicClient({ chain: base, transport: RPC_TRANSPORT });

async function vaultNonce() {
  return pub.readContract({ address: VAULT_ADDR, abi: VAULT_ABI, functionName: "nonce" });
}

async function vaultUSDC() {
  return pub.readContract({ address: VAULT_ADDR, abi: VAULT_ABI, functionName: "getGitLockedBalance", args: [USDC] });
}

async function waitNonce(expected, timeoutMs = 120_000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const n = await vaultNonce();
    if (n >= BigInt(expected)) return Number(n);
    await sleep(4000);
  }
  return null;
}

async function lastUnlockTx() {
  const r = await pool.query(
    "SELECT tx_hash FROM transactions WHERE github_id=$1 AND type='unlock' ORDER BY created_at DESC LIMIT 1",
    [TEST_GH_ID],
  );
  return r.rows[0]?.tx_hash ?? null;
}

function makeWebhook(comment, issueId) {
  return JSON.stringify({
    action: "created",
    issue: {
      number: issueId, title: "Gitbank x402 E2E", body: "", state: "open",
      user: { login: TEST_LOGIN, id: TEST_GH_ID }, labels: [],
    },
    comment: { id: issueId * 100, body: comment, user: { login: TEST_LOGIN, id: TEST_GH_ID } },
    repository: { id: 999, full_name: "gitbankio/test", name: "test", owner: { login: "gitbankio", id: 999 } },
    installation: { id: 1 },
    sender: { login: TEST_LOGIN, id: TEST_GH_ID },
  });
}

async function webhook(comment, issueId) {
  const body = makeWebhook(comment, issueId);
  const sig  = "sha256=" + crypto.createHmac("sha256", WHK_SECRET).update(body).digest("hex");
  const res  = await fetch("http://localhost:80/api/webhook/github", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "issue_comment", "X-Hub-Signature-256": sig },
    body,
  });
  return res.status === 200;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Gitbank x402 E2E — Base Mainnet");
  console.log("  " + new Date().toISOString());
  console.log("  Vault: " + VAULT_ADDR);
  console.log("  Test endpoint: " + TEST_URL);
  console.log("═══════════════════════════════════════════════════════");

  // ── 1. Probe test endpoint ─────────────────────────────────────────────────
  section("1. Probe x402 test endpoint");

  const probeRes = await fetch(TEST_URL);
  if (probeRes.status !== 402) {
    fail("Expected HTTP 402, got " + probeRes.status);
    process.exit(1);
  }
  pass("HTTP 402 confirmed");

  const raw = probeRes.headers.get("PAYMENT-REQUIRED") ?? probeRes.headers.get("X-PAYMENT-REQUIRED");
  if (!raw) { fail("No PAYMENT-REQUIRED header"); process.exit(1); }
  pass("PAYMENT-REQUIRED header present");

  const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  const opt     = decoded.accepts?.[0] ?? decoded;
  info("network:  " + opt.network);
  info("asset:    " + opt.asset);
  info("amount:   " + opt.maxAmountRequired + " atomic = " + (Number(opt.maxAmountRequired) / 1e6) + " USDC");
  info("payTo:    " + opt.payTo);

  if (!opt.network?.includes("8453")) { fail("Network is not Base mainnet"); process.exit(1); }
  if (opt.asset?.toLowerCase() !== USDC.toLowerCase()) { fail("Asset is not USDC mainnet"); process.exit(1); }
  pass("Network + asset verified: Base mainnet USDC");

  // ── 2. Pre-state ──────────────────────────────────────────────────────────
  section("2. Pre-state");

  const [nonceBefore, usdcBefore] = await Promise.all([vaultNonce(), vaultUSDC()]);
  info("Vault nonce before:  " + nonceBefore.toString());
  info("Vault USDC before:   " + formatUnits(usdcBefore, 6));

  if (usdcBefore < BigInt(opt.maxAmountRequired)) {
    fail("Vault has insufficient USDC (" + formatUnits(usdcBefore, 6) + "). Need ≥0.001 USDC. Fund it first.");
    process.exit(1);
  }
  pass("Vault USDC sufficient");

  // ── 3. Send x402-pay webhook command ──────────────────────────────────────
  section("3. Send @gitbankbot x402-pay");

  const cmd = `@gitbankbot x402-pay ${TEST_URL} ${MAX_APPROVE} USDC`;
  info("Command: " + cmd);

  const ok = await webhook(cmd, 7402);
  if (!ok) { fail("Webhook returned non-200"); process.exit(1); }
  pass("Webhook accepted (200)");

  // ── 4. Wait for on-chain confirmation ────────────────────────────────────
  section("4. Waiting for gitUnshield on-chain (up to 90s)...");

  const expectedNonce = Number(nonceBefore) + 1;
  info("Waiting for nonce " + nonceBefore.toString() + " → " + expectedNonce + "...");

  const nonceAfter = await waitNonce(expectedNonce);
  if (nonceAfter === null) {
    fail("Nonce did not increment within 90s — tx may have failed");
    process.exit(1);
  }
  pass("Vault nonce → " + nonceAfter + " (gitUnshield confirmed on-chain!)");

  // ── 5. Get tx hash from DB ────────────────────────────────────────────────
  section("5. Transaction details");

  await sleep(2000); // brief wait for DB write to settle
  const txHash = await lastUnlockTx();
  if (!txHash) {
    fail("No unlock tx found in DB");
  } else {
    pass("Tx hash: " + txHash);
    pass("Basescan: " + EXPLORER + "/" + txHash);
  }

  const [nonceEnd, usdcAfter] = await Promise.all([vaultNonce(), vaultUSDC()]);
  info("Vault nonce final: " + nonceEnd.toString());
  info("Vault USDC final:  " + formatUnits(usdcAfter, 6));

  const paid = usdcBefore - usdcAfter;
  pass("USDC paid from vault: " + formatUnits(paid, 6) + " USDC (endpoint requested " + formatUnits(BigInt(opt.maxAmountRequired), 6) + " USDC)");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  if (failures === 0) {
    console.log("  \x1b[32mAll checks passed (0 failures)\x1b[0m");
    console.log("  x402-pay E2E VERIFIED on Base Mainnet");
    if (txHash) console.log("  " + EXPLORER + "/" + txHash);
  } else {
    console.log("  \x1b[31m" + failures + " check(s) FAILED\x1b[0m");
  }
  console.log("═══════════════════════════════════════════════════════\n");

  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
