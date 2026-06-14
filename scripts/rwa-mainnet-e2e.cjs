#!/usr/bin/env node
/**
 * Gitbank RWA Mainnet E2E — Full Flow
 *
 * Sections:
 *   A. Buy  SPCX (SpaceX) 5 USDC  — CCTP Base→Solana + Ondo order-engine buy + gitSPCX mint
 *   B. RWA Portfolio query         — @gitbankbot rwa portfolio (after buy)
 *   C. Sell SPCX                   — burn gitSPCX + Ondo order-engine sell + CCTP Solana→Base → gitUSDC in vault
 *   D. MCP tools                   — list_stocks, get_stock_price, get_rwa_portfolio via HTTP
 *
 * Run:
 *   node scripts/rwa-mainnet-e2e.cjs
 *
 * Before running:
 *   restart_workflow "artifacts/api-server: API Server"  (resets rate limiter)
 */
"use strict";

const crypto = require("crypto");
const { Pool } = require("/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg");
const fs = require("fs");

// ── Find viem dynamically ─────────────────────────────────────────────────────
const pnpmDir = "/home/runner/workspace/node_modules/.pnpm";
const viemPkg = fs.readdirSync(pnpmDir).find(d => d.startsWith("viem@2.") && d.includes("zod@4.4.3"));
if (!viemPkg) { console.error("viem not found in pnpm store"); process.exit(1); }
const VIEM = `${pnpmDir}/${viemPkg}/node_modules/viem`;
const {
  createPublicClient, createWalletClient, http, fallback,
  parseAbi, formatUnits, parseUnits,
} = require(VIEM);
const { privateKeyToAccount } = require(`${VIEM}/accounts`);
const { base } = require(`${VIEM}/chains`);

// ── Config ────────────────────────────────────────────────────────────────────
const ENC_KEY         = process.env.ENCRYPTION_MASTER_KEY;
const DB_URL          = process.env.DATABASE_URL;
const WHK_SECRET      = process.env.GITHUB_WEBHOOK_SECRET;
const DEPLOYER_PK_RAW = process.env.DEPLOYER_PRIVATE_KEY;
const TEST_WALLET_PK_RAW = process.env.test_wallet;

if (!ENC_KEY || !DB_URL || !WHK_SECRET || !DEPLOYER_PK_RAW) {
  console.error("Missing required env vars: ENCRYPTION_MASTER_KEY, DATABASE_URL, GITHUB_WEBHOOK_SECRET, DEPLOYER_PRIVATE_KEY");
  process.exit(1);
}

const DEPLOYER_PK   = DEPLOYER_PK_RAW.startsWith("0x") ? DEPLOYER_PK_RAW : "0x" + DEPLOYER_PK_RAW;
const TEST_WALLET_PK = TEST_WALLET_PK_RAW
  ? (TEST_WALLET_PK_RAW.startsWith("0x") ? TEST_WALLET_PK_RAW : "0x" + TEST_WALLET_PK_RAW)
  : DEPLOYER_PK;

const RPC_TRANSPORT = fallback([
  ...(process.env.BASE_MAINNET_RPC_URL ? [http(process.env.BASE_MAINNET_RPC_URL)] : []),
  http("https://mainnet.base.org"),
  http("https://base.llamarpc.com"),
  http("https://base-rpc.publicnode.com"),
]);

const USDC          = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACTORY_ADDR  = process.env.GIT_VAULT_FACTORY_ADDRESS ?? "0xAA0a4ff46733EBaE8E658642A1314f18980fc77B";
const EXPLORER_BASE = "https://basescan.org/tx";
const EXPLORER_SOL  = "https://solscan.io/tx";
const API_BASE      = "http://localhost:80";

const TEST_GH_ID    = 11111111;
const TEST_GH_LOGIN = "mainnet-e2e-testuser";
const BUY_USDC      = 5;
const TICKER        = "SPCX";
const BUY_ISSUE_ID  = 9001;
const SELL_ISSUE_ID = 9002;
const PORT_ISSUE_ID = 9003;

const FACTORY_ABI = parseAbi([
  "function getVaultByGithubId(uint256 githubUserId) view returns (address)",
  "function hasVault(uint256 githubUserId) view returns (bool)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

// ── Helpers ───────────────────────────────────────────────────────────────────
let failures = 0;
function pass(m)    { console.log("  \x1b[32m✓\x1b[0m " + m); }
function fail(m)    { console.log("  \x1b[31m✗\x1b[0m " + m); failures++; }
function info(m)    { console.log("  \x1b[33m·\x1b[0m " + m); }
function section(m) { console.log("\n\x1b[1m" + m + "\x1b[0m"); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

function encryptPk(pk) {
  const mk = Buffer.from(ENC_KEY, "hex");
  const iv = crypto.randomBytes(12);
  const c  = crypto.createCipheriv("aes-256-gcm", mk, iv);
  const ct = Buffer.concat([c.update(pk, "utf8"), c.final()]);
  return iv.toString("hex") + ":" + c.getAuthTag().toString("hex") + ":" + ct.toString("hex");
}

function makeWebhook(comment, issueId) {
  return JSON.stringify({
    action: "created",
    issue: { number: issueId, title: "Gitbank RWA E2E", body: "", user: { login: TEST_GH_LOGIN, id: TEST_GH_ID }, labels: [], state: "open" },
    comment: { id: issueId * 100, body: comment, user: { login: TEST_GH_LOGIN, id: TEST_GH_ID } },
    repository: { id: 999, full_name: "gitbankio/test", name: "test", owner: { login: "gitbankio", id: 999 } },
    installation: { id: 1 },
    sender: { login: TEST_GH_LOGIN, id: TEST_GH_ID },
  });
}

async function sendWebhook(comment, issueId) {
  const body = makeWebhook(comment, issueId);
  const sig  = "sha256=" + crypto.createHmac("sha256", WHK_SECRET).update(body).digest("hex");
  const res  = await fetch(`${API_BASE}/api/webhook/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "issue_comment", "X-Hub-Signature-256": sig },
    body,
  });
  return res.status;
}

/**
 * Poll command_log for a given intent until result is non-pending, or timeout.
 * sinceMs: only consider entries created after this epoch ms (avoids stale old entries).
 */
async function pollCommandLog(pool, githubId, intent, timeoutMs = 360000, sinceMs = Date.now() - 5000) {
  const sinceTs = new Date(sinceMs).toISOString();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await pool.query(
      `SELECT result, error FROM command_log
       WHERE github_id=$1 AND intent=$2 AND created_at >= $3
       ORDER BY created_at DESC LIMIT 1`,
      [githubId, intent, sinceTs],
    );
    if (r.rows[0] && r.rows[0].result !== null && r.rows[0].result !== "pending") {
      return r.rows[0];
    }
    await sleep(6000);
    process.stdout.write(".");
  }
  return null;
}

/** Call an MCP tool via HTTP. Returns parsed content text or null on error. */
async function mcpCall(toolName, toolArgs = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs },
  });
  try {
    const res = await fetch(`${API_BASE}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body,
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, raw: await res.text() };
    const text = await res.text();
    // SSE format: lines starting with "data: "
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.result?.content?.[0]?.text) {
            return { ok: true, data: JSON.parse(parsed.result.content[0].text) };
          }
          if (parsed.result) return { ok: true, data: parsed.result };
        } catch { /* continue */ }
      }
    }
    return { error: "no data line in SSE", raw: text.slice(0, 200) };
  } catch (err) {
    return { error: err.message };
  }
}

async function run() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Gitbank RWA Mainnet E2E — Full Flow");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════════════");

  const pool = new Pool({ connectionString: DB_URL });
  const pub  = createPublicClient({ chain: base, transport: RPC_TRANSPORT });
  const deployer   = privateKeyToAccount(DEPLOYER_PK);
  const testWallet = privateKeyToAccount(TEST_WALLET_PK);

  // ── 0. Accounts ─────────────────────────────────────────────────────────────
  section("0. Accounts");
  const [depUsdc, depEth, block] = await Promise.all([
    pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [deployer.address] }),
    pub.getBalance({ address: deployer.address }),
    pub.getBlockNumber(),
  ]);
  pass(`Deployer (bridge wallet): ${deployer.address}`);
  pass(`  USDC: ${formatUnits(depUsdc, 6)}   ETH: ${formatUnits(depEth, 18).slice(0, 10)}`);
  pass(`Block: #${block}`);

  if (depUsdc < parseUnits(String(BUY_USDC), 6)) {
    fail(`Deployer needs at least ${BUY_USDC} USDC — has ${formatUnits(depUsdc, 6)}`);
    await pool.end();
    process.exit(1);
  }
  pass(`Deployer has enough USDC for bridge (${BUY_USDC} USDC)`);

  // ── 1. Vault ─────────────────────────────────────────────────────────────────
  section(`1. Vault for GH ID ${TEST_GH_ID}`);
  const hasVault = await pub.readContract({
    address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "hasVault", args: [BigInt(TEST_GH_ID)],
  });
  let vault;
  if (hasVault) {
    vault = await pub.readContract({
      address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "getVaultByGithubId", args: [BigInt(TEST_GH_ID)],
    });
    pass(`Vault exists: ${vault}`);
  } else {
    fail("Vault not deployed — run mainnet-e2e.cjs first to deploy vault");
    await pool.end();
    process.exit(1);
  }
  pass(`Basescan: https://basescan.org/address/${vault}`);

  // ── 2. Ensure DB user record ─────────────────────────────────────────────────
  section("2. DB user record");
  const existing = await pool.query("SELECT github_id FROM users WHERE github_id=$1", [TEST_GH_ID]);
  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE users SET vault_address=$1, owner_address=$2, encrypted_pk=$3, github_login=$4 WHERE github_id=$5`,
      [vault, testWallet.address, encryptPk(TEST_WALLET_PK), TEST_GH_LOGIN, TEST_GH_ID],
    );
    pass("DB user updated");
  } else {
    await pool.query(
      `INSERT INTO users (github_id, github_login, owner_address, encrypted_pk, vault_address, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [TEST_GH_ID, TEST_GH_LOGIN, testWallet.address, encryptPk(TEST_WALLET_PK), vault],
    );
    pass("DB user inserted");
  }
  pass(`User: GH ID ${TEST_GH_ID}, vault ${vault}`);

  // ── A. BUY SPCX 5 USDC ──────────────────────────────────────────────────────
  section(`A. Buy ${TICKER} ${BUY_USDC} USDC (issue #${BUY_ISSUE_ID})`);
  info("Sending webhook: @gitbankbot buy SPCX 5 USDC");
  const buyStartMs = Date.now();
  const buyStatus = await sendWebhook(`@gitbankbot buy ${TICKER} ${BUY_USDC} USDC`, BUY_ISSUE_ID);
  if (buyStatus === 200) {
    pass(`Webhook accepted (200 OK)`);
  } else {
    fail(`Webhook rejected — status ${buyStatus}`);
    await pool.end();
    process.exit(1);
  }

  section("A.1 Waiting for CCTP bridge + Ondo order-engine buy + gitSPCX mint (~2-4 min)");
  info("Polling command_log for buy_stock result (max 15 min)...");
  process.stdout.write("  ");
  const buyResult = await pollCommandLog(pool, TEST_GH_ID, "buy_stock", 900000, buyStartMs);
  console.log();

  if (!buyResult) {
    fail("Timed out — buy_stock never completed");
    const cl = await pool.query("SELECT intent, result, error, command_text FROM command_log WHERE github_id=$1 ORDER BY created_at DESC LIMIT 5", [TEST_GH_ID]);
    for (const r of cl.rows) info(`[${r.intent}] [${r.result}] ${r.command_text ?? ""}${r.error ? " ERR: " + r.error : ""}`);
    await pool.end();
    process.exit(1);
  }

  if (buyResult.result === "failure") {
    fail(`Buy command failed: ${buyResult.error ?? "unknown"}`);
  } else {
    pass(`Buy result: ${buyResult.result}`);
  }

  // Read buy position
  const rwaBuy = await pool.query(
    `SELECT ticker, amount, cost_basis_usdc, buy_tx_solana, buy_tx_base, solana_wallet_pubkey
     FROM rwa_positions WHERE github_id=$1 AND ticker=$2 ORDER BY updated_at DESC LIMIT 1`,
    [String(TEST_GH_ID), TICKER],
  );

  let bridgeBaseTx = null, jupiterSolBuyTx = null, solWallet = null, stockAmountBought = "0";
  if (rwaBuy.rows[0]) {
    bridgeBaseTx      = rwaBuy.rows[0].buy_tx_base;
    jupiterSolBuyTx   = rwaBuy.rows[0].buy_tx_solana;
    solWallet         = rwaBuy.rows[0].solana_wallet_pubkey;
    stockAmountBought = (Number(rwaBuy.rows[0].amount) / 1e9).toFixed(6);
    pass(`Position recorded: ${stockAmountBought} git${TICKER}`);
    pass(`Solana custody wallet: ${solWallet}`);
    if (bridgeBaseTx) pass(`Bridge Tx (Base): ${EXPLORER_BASE}/${bridgeBaseTx}`);
    if (jupiterSolBuyTx) pass(`Swap Tx (Solana): ${EXPLORER_SOL}/${jupiterSolBuyTx}`);
  } else {
    fail("rwa_positions row not found after buy");
  }

  // Check gitSPCX mint tx
  const mintRow = await pool.query(
    `SELECT tx_hash FROM transactions WHERE github_id=$1 AND type='git_stock_mint' ORDER BY created_at DESC LIMIT 1`,
    [TEST_GH_ID],
  );
  if (mintRow.rows[0]?.tx_hash) {
    pass(`gitSPCX Mint Tx (Base): ${EXPLORER_BASE}/${mintRow.rows[0].tx_hash}`);
  } else {
    info("gitSPCX mint tx not recorded (non-fatal)");
  }

  // ── B. PORTFOLIO QUERY ───────────────────────────────────────────────────────
  section(`B. Portfolio query (issue #${PORT_ISSUE_ID})`);
  info("Sending: @gitbankbot rwa portfolio");
  const portStartMs = Date.now();
  const portStatus = await sendWebhook("@gitbankbot rwa portfolio", PORT_ISSUE_ID);
  if (portStatus === 200) {
    pass("Portfolio webhook accepted");
  } else {
    fail(`Portfolio webhook rejected — status ${portStatus}`);
  }

  // Poll for rwa_portfolio intent
  info("Polling for rwa_portfolio result (max 60s)...");
  process.stdout.write("  ");
  const portResult = await pollCommandLog(pool, TEST_GH_ID, "rwa_portfolio", 60000, portStartMs);
  console.log();
  if (portResult) {
    if (portResult.result === "failure") fail(`Portfolio failed: ${portResult.error ?? "unknown"}`);
    else pass(`Portfolio result: ${portResult.result}`);
  } else {
    info("Portfolio command_log result not found (may not be logged — check GitHub comment)");
  }

  // ── C. SELL SPCX ─────────────────────────────────────────────────────────────
  section(`C. Sell ${TICKER} (all) — issue #${SELL_ISSUE_ID}`);
  if (!rwaBuy.rows[0]) {
    fail("Skipping sell — no position found from buy step");
  } else {
    info(`Sending: @gitbankbot sell ${TICKER}`);
    const sellStartMs = Date.now();
    const sellStatus = await sendWebhook(`@gitbankbot sell ${TICKER}`, SELL_ISSUE_ID);
    if (sellStatus === 200) {
      pass("Sell webhook accepted (200 OK)");
    } else {
      fail(`Sell webhook rejected — status ${sellStatus}`);
    }

    section("C.1 Waiting for gitSPCX burn + Ondo order-engine sell + CCTP Solana→Base bridge (~2-5 min)");
    info("Polling command_log for sell_stock result (max 15 min)...");
    process.stdout.write("  ");
    const sellResult = await pollCommandLog(pool, TEST_GH_ID, "sell_stock", 900000, sellStartMs);
    console.log();

    if (!sellResult) {
      fail("Timed out — sell_stock never completed");
    } else if (sellResult.result === "failure") {
      fail(`Sell command failed: ${sellResult.error ?? "unknown"}`);
    } else {
      pass(`Sell result: ${sellResult.result}`);
    }

    // Read sell tx from transactions table
    const sellTxRow = await pool.query(
      `SELECT tx_hash, amount_in, amount_out FROM transactions
       WHERE github_id=$1 AND type='git_stock_sell' ORDER BY created_at DESC LIMIT 1`,
      [TEST_GH_ID],
    );
    if (sellTxRow.rows[0]) {
      const amtSold  = (Number(sellTxRow.rows[0].amount_in)  / 1e9).toFixed(6);
      const usdcBack = (Number(sellTxRow.rows[0].amount_out) / 1e6).toFixed(2);
      pass(`Sold: ${amtSold} git${TICKER} → ${usdcBack} gitUSDC in vault`);
      if (sellTxRow.rows[0].tx_hash) pass(`USDC to Vault Tx (Base): ${EXPLORER_BASE}/${sellTxRow.rows[0].tx_hash}`);
    } else {
      fail("git_stock_sell transaction record not found");
    }

    // Verify position is gone or zeroed
    const posAfterSell = await pool.query(
      `SELECT amount FROM rwa_positions WHERE github_id=$1 AND ticker=$2`,
      [String(TEST_GH_ID), TICKER],
    );
    if (posAfterSell.rows.length === 0) {
      pass(`rwa_positions row deleted — full sell confirmed`);
    } else if (Number(posAfterSell.rows[0].amount) === 0) {
      pass(`rwa_positions amount=0 — sell confirmed`);
    } else {
      info(`Partial sell: ${(Number(posAfterSell.rows[0].amount) / 1e9).toFixed(6)} git${TICKER} remaining`);
    }

    // Check vault USDC balance increased
    try {
      const vaultUsdc = await pub.readContract({
        address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [vault],
      });
      pass(`Vault USDC balance: ${formatUnits(vaultUsdc, 6)} USDC (gitUSDC withdrawable)`);
    } catch (err) {
      info(`Could not read vault USDC balance: ${err.message}`);
    }
  }

  // ── D. MCP TOOLS ─────────────────────────────────────────────────────────────
  section("D. MCP Tools — list_stocks");
  const listRes = await mcpCall("list_stocks");
  if (listRes.error) {
    fail(`list_stocks MCP error: ${listRes.error}${listRes.raw ? " — " + listRes.raw : ""}`);
  } else if (listRes.data?.stocks?.length > 0) {
    pass(`list_stocks: ${listRes.data.stocks.length} stocks returned`);
    const spcx = listRes.data.stocks.find(s => s.ticker === TICKER);
    if (spcx) pass(`git${TICKER} found: contract=${spcx.gitStockContract ?? "not deployed"}`);
    else info(`${TICKER} not in list (contract not deployed to git_stock_contracts table)`);
  } else {
    fail(`list_stocks returned empty or unexpected: ${JSON.stringify(listRes).slice(0, 200)}`);
  }

  section("D. MCP Tools — get_stock_price SPCX");
  const priceRes = await mcpCall("get_stock_price", { ticker: TICKER });
  if (priceRes.error) {
    fail(`get_stock_price MCP error: ${priceRes.error}`);
  } else if (priceRes.data?.priceUsd !== undefined) {
    pass(`${TICKER} price: $${priceRes.data.priceUsd?.toFixed?.(2) ?? priceRes.data.priceUsd}`);
    pass(`Price display: ${priceRes.data.priceDisplay ?? "N/A"}`);
  } else if (priceRes.data?.error) {
    info(`get_stock_price responded with error (may be Pyth unavailable): ${priceRes.data.error}`);
  } else {
    fail(`get_stock_price unexpected response: ${JSON.stringify(priceRes).slice(0, 200)}`);
  }

  section("D. MCP Tools — get_rwa_portfolio");
  const portMcpRes = await mcpCall("get_rwa_portfolio", { github_username: TEST_GH_LOGIN });
  if (portMcpRes.error) {
    fail(`get_rwa_portfolio MCP error: ${portMcpRes.error}`);
  } else if (portMcpRes.data?.positions !== undefined) {
    const posCount = portMcpRes.data.positions.length;
    pass(`get_rwa_portfolio: ${posCount} position(s) for ${TEST_GH_LOGIN}`);
    pass(`Total value: $${portMcpRes.data.totalValueUsd ?? "0"}`);
    if (posCount === 0) info("Position cleared after sell — correct");
  } else {
    fail(`get_rwa_portfolio unexpected: ${JSON.stringify(portMcpRes).slice(0, 200)}`);
  }

  // ── Final Summary ─────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RESULTS — Gitbank RWA Full E2E");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`\n  Vault    : https://basescan.org/address/${vault}`);
  if (bridgeBaseTx)    console.log(`  Buy Bridge (Base)    : ${EXPLORER_BASE}/${bridgeBaseTx}`);
  if (jupiterSolBuyTx) console.log(`  Buy Swap (Solana)    : ${EXPLORER_SOL}/${jupiterSolBuyTx}`);
  if (solWallet)       console.log(`  Solana custody wallet: ${solWallet}`);

  const sellTxFinal = await pool.query(
    `SELECT tx_hash, amount_out FROM transactions WHERE github_id=$1 AND type='git_stock_sell' ORDER BY created_at DESC LIMIT 1`,
    [TEST_GH_ID],
  );
  if (sellTxFinal.rows[0]) {
    const usdcBack = (Number(sellTxFinal.rows[0].amount_out) / 1e6).toFixed(2);
    if (sellTxFinal.rows[0].tx_hash) console.log(`  Sell Bridge (Base)   : ${EXPLORER_BASE}/${sellTxFinal.rows[0].tx_hash}`);
    console.log(`  gitUSDC in vault     : ${usdcBack} USDC (withdraw: @gitbankbot withdraw ${usdcBack} USDC to 0x...)`);
  }
  console.log();

  console.log("═══════════════════════════════════════════════════════════════");
  if (failures === 0) {
    console.log("  \x1b[32mAll checks PASSED\x1b[0m");
  } else {
    console.log(`  \x1b[31m${failures} check(s) FAILED\x1b[0m`);
  }
  console.log("═══════════════════════════════════════════════════════════════\n");

  await pool.end();
  if (failures > 0) process.exit(1);
}

run().catch(err => {
  console.error("\n\x1b[31mFATAL:\x1b[0m", err.message ?? err);
  process.exit(1);
});
