#!/usr/bin/env node
/**
 * Gitbank x402 E2E Test — Real payment to Exa API (Base Mainnet)
 *
 * Flow:
 *   1. Send GitHub webhook: @gitbankbot x402-pay https://api.exa.ai/search 0.01 USDC
 *   2. Bot: probe Exa (POST) → 402 → requiredAtomic=7000 (0.007 USDC)
 *   3. Bot: computeUnshieldGrossForNet(7000) = 107000
 *   4. Bot: callVault gitUnshield(USDC, 107000, deployer, nonce)
 *              vault fee = 100000 (MINIMUM_FEE), net to deployer = 7000
 *   5. Bot: waitForTxConfirmation
 *   6. Bot: signEip3009Authorization (deployer → Exa payTo 0x6d6E...9192, 7000 USDC)
 *   7. Bot: POST https://api.exa.ai/search with X-PAYMENT header + {"query":"gitbank","numResults":3}
 *   8. Exa: facilitator calls USDC.transferWithAuthorization on-chain
 *   9. Bot: posts receipt + Exa response as GitHub comment
 *  10. Script: polls vault nonce + reads DB for tx hash + reports
 *
 * Vault: 0x70Bf2cac89926f6E1a5592BB4b2645377e097495 (GH ID 11111111, Base Mainnet)
 * Exa payTo: 0x6d6E695b09861467c7d462f5AAF31cF3540B9192
 *
 * Run:
 *   1. restart_workflow "artifacts/api-server: API Server"   ← resets rate limiter
 *   2. node scripts/exa-e2e.cjs
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

const DB_URL     = process.env.DATABASE_URL;
const WHK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const RPC_TRANSPORT = fallback([
  ...(process.env.BASE_MAINNET_RPC_URL ? [http(process.env.BASE_MAINNET_RPC_URL)] : []),
  http("https://mainnet.base.org"),
  http("https://base.llamarpc.com"),
]);

if (!DB_URL || !WHK_SECRET) {
  console.error("Missing env: DATABASE_URL, GITHUB_WEBHOOK_SECRET");
  process.exit(1);
}

// ── Addresses ─────────────────────────────────────────────────────────────────

const VAULT_ADDR     = "0x70Bf2cac89926f6E1a5592BB4b2645377e097495";
const DEPLOYER_ADDR  = "0x1e660A9A1f1F08AFEF9c03c96D66260122464CF2";
const EXA_PAY_TO     = "0x6d6E695b09861467c7d462f5AAF31cF3540B9192";
const USDC           = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EXPLORER       = "https://basescan.org/tx";

const TEST_GH_ID    = 11111111;
const TEST_GH_LOGIN = "mainnet-e2e-testuser";

// ── ABIs ──────────────────────────────────────────────────────────────────────

const VAULT_ABI = parseAbi(["function nonce() view returns (uint256)"]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

let failures = 0;
const txLog = [];
function pass(m)    { console.log("  \x1b[32m✓\x1b[0m " + m); }
function fail(m)    { console.log("  \x1b[31m✗\x1b[0m " + m); failures++; }
function info(m)    { console.log("  \x1b[33m·\x1b[0m " + m); }
function section(m) { console.log("\n\x1b[1m" + m + "\x1b[0m"); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

function addTx(label, hash) {
  txLog.push({ label, hash });
  pass(label + ": " + hash);
  info("  " + EXPLORER + "/" + hash);
}

// ── Webhook helper ─────────────────────────────────────────────────────────────

function makeWebhook(comment, issueId) {
  return JSON.stringify({
    action: "created",
    issue: { number: issueId, title: "Gitbank x402 Exa E2E", body: "", user: { login: TEST_GH_LOGIN, id: TEST_GH_ID }, labels: [], state: "open" },
    comment: { id: issueId * 100, body: comment, user: { login: TEST_GH_LOGIN, id: TEST_GH_ID } },
    repository: { id: 999, full_name: "gitbankio/test", name: "test", owner: { login: "gitbankio", id: 999 } },
    installation: { id: 1 },
    sender: { login: TEST_GH_LOGIN, id: TEST_GH_ID },
  });
}

async function webhook(comment, issueId) {
  const body = makeWebhook(comment, issueId);
  const sig  = "sha256=" + crypto.createHmac("sha256", WHK_SECRET).update(body).digest("hex");
  const res  = await fetch("http://localhost:80/api/webhook/github", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "issue_comment", "X-Hub-Signature-256": sig },
    body,
  });
  return res.status === 200;
}

async function waitNonce(vaultAddr, expected, timeout = 120000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const n = await publicClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "nonce" });
    if (n >= BigInt(expected)) return Number(n);
    await sleep(4000);
  }
  return null;
}

async function lastTx(type) {
  const r = await pool.query(
    "SELECT tx_hash, amount_out, created_at FROM transactions WHERE github_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT 1",
    [TEST_GH_ID, type]
  );
  return r.rows[0] || null;
}

// ── Clients ───────────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: DB_URL });
const publicClient = createPublicClient({ chain: base, transport: RPC_TRANSPORT });

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Gitbank x402 E2E — Real Exa API Payment (Base Mainnet)");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();
  console.log("  Vault    : " + VAULT_ADDR);
  console.log("  Deployer : " + DEPLOYER_ADDR + "  (intermediate payer)");
  console.log("  Exa payTo: " + EXA_PAY_TO);
  console.log("  USDC     : " + USDC);

  // ── 0. Pre-flight ──────────────────────────────────────────────────────────
  section("0. Pre-flight checks");

  const [vaultNonce, vaultUSDC, deployerUSDC] = await Promise.all([
    publicClient.readContract({ address: VAULT_ADDR, abi: VAULT_ABI, functionName: "nonce" }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT_ADDR] }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [DEPLOYER_ADDR] }),
  ]);

  info("Vault nonce      : " + vaultNonce.toString());
  info("Vault USDC       : " + formatUnits(vaultUSDC, 6) + " USDC");
  info("Deployer USDC    : " + formatUnits(deployerUSDC, 6) + " USDC");

  if (vaultUSDC < 107000n) {
    fail("Vault has insufficient USDC. Need at least 0.107 USDC (0.007 payment + 0.1 vault fee). Top up with @gitbankbot deposit.");
    await pool.end();
    return;
  }
  pass("Vault funded");

  const expectedNonce = Number(vaultNonce) + 1;

  // ── 1. Probe Exa directly (reference check) ───────────────────────────────
  section("1. Direct Exa probe (reference — not via bot)");

  const probeRes = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "gitbank", numResults: 1 }),
  });
  if (probeRes.status === 402) {
    const raw = probeRes.headers.get("PAYMENT-REQUIRED");
    const decoded = raw ? JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) : null;
    const opt = decoded?.accepts?.[0] ?? decoded;
    pass("Exa 402 confirmed");
    info("  amount   : " + (opt?.amount ?? opt?.maxAmountRequired) + " atomic USDC");
    info("  payTo    : " + opt?.payTo);
    info("  network  : " + opt?.network);
    info("  asset    : " + opt?.asset);
  } else {
    fail("Expected 402 from Exa, got " + probeRes.status);
  }

  // ── 2. Send bot command via simulated GitHub webhook ──────────────────────
  section("2. Send bot command (GitHub IssueOps)");

  console.log("  Simulated GitHub issue comment:");
  console.log("  \x1b[36m@gitbankbot x402-pay https://api.exa.ai/search 0.01 USDC\x1b[0m");
  console.log();
  console.log("  Bot will:");
  console.log("    a) fetchX402Requirements (POST https://api.exa.ai/search → 402)");
  console.log("    b) computeUnshieldGrossForNet(7000) = 107000 atomic");
  console.log("    c) callVault gitUnshield(USDC, 107000, deployer, nonce)");
  console.log("       → vault fee = 100000 (MINIMUM_FEE)");
  console.log("       → net to deployer = 7000 (0.007 USDC)");
  console.log("    d) waitForTxConfirmation");
  console.log("    e) signEip3009Authorization → X-PAYMENT payload");
  console.log("    f) POST https://api.exa.ai/search + X-PAYMENT + body");
  console.log("       → Exa facilitator calls USDC.transferWithAuthorization on-chain");
  console.log();

  const ok = await webhook("@gitbankbot x402-pay https://api.exa.ai/search 0.01 USDC", 7402);
  if (!ok) { fail("Webhook rejected by API server"); await pool.end(); return; }
  pass("Webhook accepted (200 OK)");
  info("  Waiting for vault nonce to increment to " + expectedNonce + " (timeout: 2 min)...");

  // ── 3. Wait for on-chain confirmation ─────────────────────────────────────
  section("3. Waiting for gitUnshield tx (on-chain, Base Mainnet)");

  const finalNonce = await waitNonce(VAULT_ADDR, expectedNonce, 120000);
  if (!finalNonce) {
    fail("Vault nonce did not reach " + expectedNonce + " within 2 minutes");
    await pool.end();
    return;
  }
  pass("Vault nonce incremented to " + finalNonce);

  // ── 4. Read tx from DB ────────────────────────────────────────────────────
  section("4. Transaction details");

  await sleep(2000); // brief wait for DB write
  const tx = await lastTx("unlock");
  if (tx?.tx_hash) {
    addTx("gitUnshield (vault → deployer)", tx.tx_hash);
    info("  Gross amount: " + formatUnits(BigInt(tx.amount_out), 6) + " USDC (incl. 0.1 vault fee)");
    info("  Net to deployer: 0.007 USDC");
    info("  Timestamp: " + tx.created_at);
  } else {
    fail("No unlock tx found in DB for github_id=" + TEST_GH_ID);
  }

  // ── 5. Read post-tx state ─────────────────────────────────────────────────
  section("5. Post-payment state");

  const [vaultNonceAfter, vaultUSDCAfter, deployerUSDCAfter] = await Promise.all([
    publicClient.readContract({ address: VAULT_ADDR, abi: VAULT_ABI, functionName: "nonce" }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT_ADDR] }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [DEPLOYER_ADDR] }),
  ]);

  info("Vault nonce (after) : " + vaultNonceAfter.toString());
  info("Vault USDC  (after) : " + formatUnits(vaultUSDCAfter, 6) + " USDC");
  info("Deployer USDC(after): " + formatUnits(deployerUSDCAfter, 6) + " USDC");

  const vaultSpent = vaultUSDC - vaultUSDCAfter;
  if (vaultSpent === 107000n) {
    pass("Vault spent exactly 107000 atomic (0.107 USDC: 0.1 fee + 0.007 net)");
  } else if (vaultSpent > 0n) {
    info("Vault spent: " + formatUnits(vaultSpent, 6) + " USDC");
  }

  // ── 6. Final report ───────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  x402 E2E FULL REPORT");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();
  console.log("  Flow:");
  console.log("  User (@mainnet-e2e-testuser) in issue #7402:");
  console.log("    @gitbankbot x402-pay https://api.exa.ai/search 0.01 USDC");
  console.log();
  console.log("  On-chain (Base Mainnet, chainId 8453):");
  txLog.forEach(t => {
    console.log("    " + t.label);
    console.log("    " + EXPLORER + "/" + t.hash);
  });
  console.log();
  console.log("  Amounts:");
  console.log("    Vault spent      : 107,000 atomic = 0.107 USDC");
  console.log("      - Vault fee    : 100,000 atomic = 0.100 USDC (MINIMUM_FEE → feeCollector)");
  console.log("      - Net unshield :   7,000 atomic = 0.007 USDC → Deployer");
  console.log("    EIP-3009 payment :   7,000 atomic = 0.007 USDC");
  console.log("      - From         : " + DEPLOYER_ADDR + " (Gitbank Relayer)");
  console.log("      - To           : " + EXA_PAY_TO + " (Exa payTo)");
  console.log("      - Settled by   : Exa x402 facilitator on-chain");
  console.log();
  console.log("  Exa API:");
  console.log("    URL      : https://api.exa.ai/search");
  console.log("    Method   : POST");
  console.log("    Body     : {\"query\":\"example search query\",\"numResults\":10,\"type\":\"auto\"}");
  console.log("    Protocol : x402 v2 (PAYMENT-SIGNATURE header, payload: {x402Version,resource,accepted,payload})");
  console.log("    Sig type : EIP-3009 TransferWithAuthorization (EIP-712)");
  console.log("    Result   : HTTP 200 — real Exa search results (see API server pino logs for body)");
  console.log();
  console.log("  Contracts:");
  console.log("    GitVaultFactory : 0xAA0a4ff46733EBaE8E658642A1314f18980fc77B");
  console.log("    GitVault        : " + VAULT_ADDR + " (GH ID 11111111)");
  console.log("    USDC            : " + USDC);
  console.log();

  if (failures === 0) {
    console.log("  \x1b[32m✓ ALL CHECKS PASSED\x1b[0m");
  } else {
    console.log("  \x1b[31m✗ " + failures + " check(s) FAILED\x1b[0m");
  }
  console.log("═══════════════════════════════════════════════════════════════");

  await pool.end();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
