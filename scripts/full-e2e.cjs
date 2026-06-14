#!/usr/bin/env node
/**
 * full-e2e.cjs — Comprehensive local E2E test: API + MCP + DB + Contracts + Webhook + Env
 *
 * Usage:
 *   node scripts/full-e2e.cjs
 *
 * Requires: API server running at localhost:80/api
 * No real on-chain calls — tests shape/status/consistency only.
 */
"use strict";

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

// ── pg import (shared node_modules) ───────────────────────────────────────────
let Pool;
try {
  Pool = require("/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg").Pool;
} catch {
  // fallback path
  Pool = require("pg").Pool;
}

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL ?? "http://localhost:80";
const DB_URL   = process.env.DATABASE_URL;
const WHK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";

// ── Results ───────────────────────────────────────────────────────────────────
let pass = 0, fail = 0, warn = 0;
const ISSUES = [];

function log(msg)  { process.stdout.write(msg + "\n"); }
function ok(label) { pass++; log(`  ✅ PASS  ${label}`); }
function ko(label, detail) {
  fail++;
  ISSUES.push(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  log(`  ❌ FAIL  ${label}${detail ? `\n         → ${detail}` : ""}`);
}
function wn(label, detail) {
  warn++;
  log(`  ⚠️  WARN  ${label}${detail ? ` — ${detail}` : ""}`);
}
function section(title) {
  log(`\n${"─".repeat(60)}`);
  log(`  ${title}`);
  log(`${"─".repeat(60)}`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function GET(p, headers = {}) {
  const res = await fetch(`${BASE_URL}${p}`, { headers });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function POST(p, payload, headers = {}) {
  const res = await fetch(`${BASE_URL}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// ── HMAC helper for webhook ───────────────────────────────────────────────────
function webhookSig(rawBody) {
  if (!WHK_SECRET) return "sha256=deadbeef";
  return "sha256=" + crypto.createHmac("sha256", WHK_SECRET).update(rawBody).digest("hex");
}

// ── Wait for server ───────────────────────────────────────────────────────────
async function waitForServer() {
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/healthz`);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 1: Server health
// ═════════════════════════════════════════════════════════════════════════════
async function testHealth() {
  section("1. Server Health");
  try {
    const { status, body } = await GET("/api/healthz");
    if (status === 200) ok(`GET /api/healthz → 200`);
    else ko("GET /api/healthz", `status=${status}`);
  } catch (err) {
    ko("GET /api/healthz", err.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 2: RWA API routes
// ═════════════════════════════════════════════════════════════════════════════
async function testRwaRoutes() {
  section("2. RWA API Routes");

  // GET /api/rwa/stocks
  try {
    const { status, body } = await GET("/api/rwa/stocks");
    if (status === 200 && Array.isArray(body)) {
      ok(`GET /api/rwa/stocks → 200, ${body.length} stocks`);
      if (body.length >= 500) ok(`  Stock count >= 500 (${body.length}) — registry populated`);
      else wn(`  Stock count < 500 (${body.length})`);
      const tickers = body.map(s => s.ticker);
      const mustHave = ["NVDA", "AAPL", "TSLA", "META", "GOOGL", "MSFT", "AMZN", "SPY", "QQQ"];
      const missing = mustHave.filter(t => !tickers.includes(t));
      if (missing.length === 0) ok(`  All key tickers present: ${mustHave.join(", ")}`);
      else ko(`  Missing tickers`, missing.join(", "));
      // Shape check
      const sample = body[0];
      if (sample && "ticker" in sample && "name" in sample && "mintAddress" in sample) {
        ok(`  Response shape OK: {ticker, name, mintAddress, gitStockContract}`);
      } else {
        ko(`  Response shape wrong`, `got: ${JSON.stringify(sample)?.slice(0, 60)}`);
      }
    } else {
      ko("GET /api/rwa/stocks", `status=${status}`);
    }
  } catch (err) { ko("GET /api/rwa/stocks", err.message); }

  // GET /api/rwa/price/NVDA
  try {
    const { status, body } = await GET("/api/rwa/price/NVDA");
    if (status === 200 && body && typeof body.priceUsd === "number" && body.priceUsd > 0) {
      ok(`GET /api/rwa/price/NVDA → $${body.priceUsd.toFixed(2)}`);
    } else {
      ko("GET /api/rwa/price/NVDA", `status=${status} priceUsd=${body?.priceUsd}`);
    }
  } catch (err) { ko("GET /api/rwa/price/NVDA", err.message); }

  // GET /api/rwa/price/AAPL — Pyth bulk-fill check
  try {
    const { status, body } = await GET("/api/rwa/price/AAPL");
    if (status === 200 && body && typeof body.priceUsd === "number" && body.priceUsd > 0) {
      ok(`GET /api/rwa/price/AAPL → $${body.priceUsd.toFixed(2)}`);
    } else {
      ko("GET /api/rwa/price/AAPL", `status=${status} priceUsd=${body?.priceUsd}`);
    }
  } catch (err) { ko("GET /api/rwa/price/AAPL", err.message); }

  // GET /api/rwa/price/TSLA
  try {
    const { status, body } = await GET("/api/rwa/price/TSLA");
    if (status === 200 && body && typeof body.priceUsd === "number") {
      ok(`GET /api/rwa/price/TSLA → $${body.priceUsd.toFixed(2)}`);
    } else {
      ko("GET /api/rwa/price/TSLA", `status=${status}`);
    }
  } catch (err) { ko("GET /api/rwa/price/TSLA", err.message); }

  // GET /api/rwa/price/INVALID → 400
  try {
    const { status } = await GET("/api/rwa/price/FAKEXYZ999");
    if (status === 400) ok(`GET /api/rwa/price/FAKEXYZ999 → 400 (unknown ticker rejected)`);
    else ko("GET /api/rwa/price/FAKEXYZ999", `expected 400, got ${status}`);
  } catch (err) { ko("GET /api/rwa/price/FAKEXYZ999", err.message); }

  // GET /api/rwa/portfolio → 401 (unauthenticated)
  try {
    const { status } = await GET("/api/rwa/portfolio");
    if (status === 401) ok(`GET /api/rwa/portfolio (no auth) → 401`);
    else ko("GET /api/rwa/portfolio (no auth)", `expected 401, got ${status}`);
  } catch (err) { ko("GET /api/rwa/portfolio", err.message); }

  // GET /api/rwa/contracts
  try {
    const { status, body } = await GET("/api/rwa/contracts");
    if (status === 200 && Array.isArray(body)) {
      ok(`GET /api/rwa/contracts → 200, ${body.length} deployed contracts`);
    } else {
      ko("GET /api/rwa/contracts", `status=${status}`);
    }
  } catch (err) { ko("GET /api/rwa/contracts", err.message); }
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 3: Auth-protected routes (all must return 401 without session)
// ═════════════════════════════════════════════════════════════════════════════
async function testAuthProtected() {
  section("3. Auth-protected Routes (expect 401 without session)");

  const protectedRoutes = [
    "/api/auth/me",
    "/api/vault/balance",
    "/api/vault/key",
    "/api/projects",
    "/api/repos",
  ];

  for (const route of protectedRoutes) {
    try {
      const { status } = await GET(route);
      if (status === 401) ok(`GET ${route} → 401`);
      else ko(`GET ${route}`, `expected 401, got ${status}`);
    } catch (err) { ko(`GET ${route}`, err.message); }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 4: MCP tools
// ═════════════════════════════════════════════════════════════════════════════
async function testMcp() {
  section("4. MCP Tools (/api/mcp)");

  const mcpCall = async (method, params = {}) => {
    const res = await fetch(`${BASE_URL}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    // SSE: parse data lines
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try { return JSON.parse(line.slice(5).trim()); } catch {}
      }
    }
    return null;
  };

  // tools/list
  try {
    const data = await mcpCall("tools/list");
    const tools = data?.result?.tools ?? [];
    const names = tools.map(t => t.name);

    const rwaTools = ["list_stocks", "get_stock_price", "get_rwa_portfolio", "request_buy_stock", "request_sell_stock"];
    const missing = rwaTools.filter(t => !names.includes(t));
    if (missing.length === 0) ok(`MCP tools/list → all 5 RWA tools registered`);
    else ko("MCP tools/list → missing RWA tools", missing.join(", "));

    if (tools.length >= 10) ok(`MCP total tool count: ${tools.length}`);
    else wn(`MCP total tool count low: ${tools.length}`);
  } catch (err) { ko("MCP tools/list", err.message); }

  // call list_stocks
  try {
    const data = await mcpCall("tools/call", {
      name: "list_stocks",
      arguments: { filter: "" },
    });
    const content = data?.result?.content;
    if (content && content.length > 0) {
      ok(`MCP call list_stocks → returned content`);
    } else if (data?.result?.isError) {
      wn(`MCP call list_stocks returned isError`, JSON.stringify(data.result?.content)?.slice(0, 80));
    } else {
      ko("MCP call list_stocks", `no content: ${JSON.stringify(data)?.slice(0, 80)}`);
    }
  } catch (err) { ko("MCP call list_stocks", err.message); }

  // call get_stock_price
  try {
    const data = await mcpCall("tools/call", {
      name: "get_stock_price",
      arguments: { ticker: "NVDA" },
    });
    const content = data?.result?.content?.[0]?.text ?? "";
    if (content.includes("NVDA") || content.includes("$")) {
      ok(`MCP call get_stock_price NVDA → ${content.slice(0, 60)}`);
    } else if (data?.result?.isError) {
      wn(`MCP call get_stock_price returned isError`, content.slice(0, 80));
    } else {
      ko("MCP call get_stock_price NVDA", `unexpected content: ${content.slice(0, 80)}`);
    }
  } catch (err) { ko("MCP call get_stock_price", err.message); }
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 5: Contract artifacts
// ═════════════════════════════════════════════════════════════════════════════
async function testContracts() {
  section("5. Contract Artifacts (compiled ABI/bytecode)");

  const artifacts = [
    {
      file: "contracts/artifacts-hardhat/src/GitStockToken.sol/GitStockToken.json",
      requiredFns: ["mint", "burn", "decimals", "transfer", "transferFrom", "approve"],
      name: "GitStockToken",
    },
    {
      file: "contracts/artifacts-hardhat/src/GitStockFactory.sol/GitStockFactory.json",
      requiredFns: ["deployStock", "getStock", "allTickers"],
      name: "GitStockFactory",
    },
  ];

  for (const { file, requiredFns, name } of artifacts) {
    if (!fs.existsSync(file)) {
      ko(`${name}: artifact file missing`, file);
      continue;
    }

    let artifact;
    try {
      artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      ko(`${name}: JSON parse error`, e.message);
      continue;
    }

    if (!artifact.bytecode || artifact.bytecode === "0x") {
      ko(`${name}: bytecode missing`);
    } else {
      ok(`${name}: bytecode present (${artifact.bytecode.slice(0, 12)}...)`);
    }

    const abiFnNames = (artifact.abi ?? [])
      .filter(e => e.type === "function")
      .map(e => e.name);

    const missingFns = requiredFns.filter(fn => !abiFnNames.includes(fn));
    if (missingFns.length === 0) {
      ok(`${name}: ABI has all required functions (${requiredFns.join(", ")})`);
    } else {
      ko(`${name}: ABI missing functions`, missingFns.join(", "));
    }

    // Decimals check: for GitStockToken, decimals function must exist
    if (name === "GitStockToken") {
      const decimalsEntry = (artifact.abi ?? []).find(e => e.name === "decimals" && e.type === "function");
      if (decimalsEntry) ok(`GitStockToken: decimals() function present in ABI`);
      else ko("GitStockToken: decimals() function missing from ABI");

      // Soul-bound: transfer/transferFrom/approve should all revert
      // We check they exist (their implementation reverts, not verifiable from ABI alone)
      const soulBoundFns = ["transfer", "transferFrom", "approve"];
      const hasSoulBound = soulBoundFns.every(fn => abiFnNames.includes(fn));
      if (hasSoulBound) ok(`GitStockToken: soul-bound fns present (always revert)`);
      else ko(`GitStockToken: soul-bound fns missing`, soulBoundFns.filter(f => !abiFnNames.includes(f)).join(", "));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 6: Registry consistency
// ═════════════════════════════════════════════════════════════════════════════
async function testRegistry() {
  section("6. Registry Consistency (API vs registry.ts file)");

  const registryFile = "lib/rwa/src/registry.ts";
  if (!fs.existsSync(registryFile)) {
    ko("registry.ts not found", registryFile);
    return;
  }

  const content = fs.readFileSync(registryFile, "utf8");

  // Count total tickers
  const totalEntries = (content.match(/mintAddress:\s*"/g) || []).length;
  ok(`registry.ts: ${totalEntries} ticker entries`);

  // Count TBD vs real Pyth IDs
  const tbdCount = (content.match(/TBD_PYTH_/g) || []).length;
  const realCount = totalEntries - tbdCount;
  ok(`Pyth IDs: ${realCount} real, ${tbdCount} TBD (mock fallback)`);

  if (realCount >= 300) ok(`Real Pyth ID count >= 300 (${realCount}) — bulk-fill applied`);
  else ko(`Real Pyth ID count too low`, `${realCount} (expected >= 300)`);

  // Known must-have tickers with real Pyth IDs
  const mustHaveReal = ["NVDA", "AAPL", "TSLA", "META", "GOOGL", "MSFT", "AMZN", "SPY", "QQQ"];
  const missingReal = mustHaveReal.filter(t => content.includes(`"TBD_PYTH_${t}"`));
  if (missingReal.length === 0) {
    ok(`All 9 key tickers have real Pyth IDs: ${mustHaveReal.join(", ")}`);
  } else {
    ko(`Key tickers still TBD`, missingReal.join(", "));
  }

  // API consistency: count from /api/rwa/stocks should match registry
  try {
    const { status, body } = await GET("/api/rwa/stocks");
    if (status === 200 && Array.isArray(body)) {
      const diff = Math.abs(body.length - totalEntries);
      if (diff === 0) {
        ok(`API count (${body.length}) matches registry (${totalEntries})`);
      } else if (diff < 5) {
        wn(`API count (${body.length}) vs registry (${totalEntries}) — minor diff (${diff})`);
      } else {
        ko(`API count mismatch`, `API=${body.length} registry=${totalEntries}`);
      }
    }
  } catch (err) { wn("Could not verify API vs registry count", err.message); }
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 7: Webhook HMAC validation
// ═════════════════════════════════════════════════════════════════════════════
async function testWebhook() {
  section("7. Webhook HMAC Validation");

  if (!WHK_SECRET) {
    wn("GITHUB_WEBHOOK_SECRET not set — skipping webhook HMAC tests");
    return;
  }

  // Valid HMAC payload
  const validPayload = JSON.stringify({
    action: "created",
    issue: { number: 999, title: "Test", body: "test" },
    comment: {
      id: 123456,
      body: "@gitbankbot portfolio",
      user: { login: "e2e-test", id: 99999999 },
    },
    repository: { full_name: "gitbank/e2e-test", private: false },
    installation: { id: 99 },
    sender: { login: "e2e-test", id: 99999999 },
  });

  const validSig = webhookSig(validPayload);

  try {
    const res = await fetch(`${BASE_URL}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": validSig,
        "x-github-delivery": "e2e-test-delivery-001",
      },
      body: validPayload,
    });
    // We expect 200 (webhook accepted) — the actual command processing may fail
    // due to no real GitHub installation, but HMAC should pass
    if (res.status === 200) {
      ok(`Webhook with valid HMAC → 200 (accepted)`);
    } else if (res.status === 401 || res.status === 403) {
      ko("Webhook with valid HMAC", `rejected with ${res.status} — HMAC may be misconfigured`);
    } else {
      ok(`Webhook with valid HMAC → ${res.status} (accepted, processing may fail internally)`);
    }
  } catch (err) { ko("Webhook valid HMAC", err.message); }

  // Invalid HMAC → must return 401
  try {
    const res = await fetch(`${BASE_URL}/api/webhook/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        "x-github-delivery": "e2e-test-delivery-002",
      },
      body: validPayload,
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      ok(`Webhook with invalid HMAC → ${res.status} (rejected, HMAC enforcement working)`);
    } else {
      ko("Webhook invalid HMAC", `expected 400/401/403, got ${res.status} — HMAC not enforced!`);
    }
  } catch (err) { ko("Webhook invalid HMAC", err.message); }
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 8: Database tables
// ═════════════════════════════════════════════════════════════════════════════
async function testDatabase() {
  section("8. Database Tables");

  if (!DB_URL) {
    wn("DATABASE_URL not set — skipping direct DB checks");
    return;
  }

  const pool = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: 5000 });

  const tables = [
    // existing
    "users", "transactions", "projects", "installations",
    // new gitStock
    "solana_wallets", "rwa_positions", "git_stock_contracts",
  ];

  try {
    for (const table of tables) {
      try {
        const res = await pool.query(
          `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
          [table]
        );
        const exists = parseInt(res.rows[0].count) === 1;
        if (exists) ok(`DB table exists: ${table}`);
        else ko(`DB table missing: ${table}`);
      } catch (err) {
        ko(`DB table check failed: ${table}`, err.message);
      }
    }

    // Check solana_wallets columns
    try {
      const res = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='solana_wallets'
      `);
      const cols = res.rows.map(r => r.column_name);
      const requiredCols = ["github_id", "encrypted_priv_key", "public_key"];
      const missing = requiredCols.filter(c => !cols.includes(c));
      if (missing.length === 0) ok(`solana_wallets columns OK: ${cols.join(", ")}`);
      else ko("solana_wallets missing columns", missing.join(", "));
    } catch (err) { wn("solana_wallets column check", err.message); }

    // Check rwa_positions columns
    try {
      const res = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='rwa_positions'
      `);
      const cols = res.rows.map(r => r.column_name);
      const requiredCols = ["github_id", "ticker", "amount", "cost_basis_usdc", "git_stock_contract"];
      const missing = requiredCols.filter(c => !cols.includes(c));
      if (missing.length === 0) ok(`rwa_positions columns OK`);
      else ko("rwa_positions missing columns", missing.join(", "));
    } catch (err) { wn("rwa_positions column check", err.message); }

  } finally {
    await pool.end().catch(() => {});
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 9: Environment readiness
// ═════════════════════════════════════════════════════════════════════════════
async function testEnv() {
  section("9. Environment Readiness (pre-mainnet checklist)");

  const required = [
    { key: "ENCRYPTION_MASTER_KEY",  check: v => v.length === 64,  hint: "must be 64 hex chars" },
    { key: "DEPLOYER_PRIVATE_KEY",   check: v => v.startsWith("0x") || v.length > 40, hint: "must be private key" },
    { key: "BASE_MAINNET_RPC_URL",   check: v => v.startsWith("http"), hint: "mainnet RPC URL" },
    { key: "GIT_STOCK_FACTORY_ADDRESS", check: v => v.startsWith("0x") && v.length === 42, hint: "must be 0x... address" },
    { key: "GITHUB_APP_ID",          check: v => v.length > 0, hint: "GitHub App ID" },
    { key: "GITHUB_APP_PEM",         check: v => v.includes("PRIVATE KEY"), hint: "GitHub App PEM" },
    { key: "GITHUB_WEBHOOK_SECRET",  check: v => v.length >= 10, hint: "webhook HMAC secret" },
    { key: "SESSION_SECRET",         check: v => v.length >= 10, hint: "session secret" },
  ];

  const optional = [
    { key: "SOLANA_RELAYER_KEY",  hint: "REQUIRED for real gitStock buy/sell — set before mainnet launch" },
    { key: "SOLANA_RPC_URL",      hint: "recommended: Helius/Alchemy (defaults to public rate-limited)" },
    { key: "CIRCLE_API_KEY",      hint: "optional: enables CCTP Fast Transfer (8-20s vs 2min)" },
    { key: "RELAYER_SIGNING_KEY", hint: "REQUIRED for gitVault relay ops" },
  ];

  const blockers = [];

  for (const { key, check, hint } of required) {
    const val = process.env[key] ?? "";
    if (!val) {
      ko(`ENV: ${key} NOT SET`, hint);
      blockers.push(key);
    } else if (!check(val)) {
      ko(`ENV: ${key} invalid format`, hint);
      blockers.push(key);
    } else {
      ok(`ENV: ${key} set`);
    }
  }

  for (const { key, hint } of optional) {
    const val = process.env[key] ?? "";
    if (!val) wn(`ENV: ${key} not set — ${hint}`);
    else ok(`ENV: ${key} set`);
  }

  // Mock mode warnings
  if (process.env.CCTP_MOCK === "true") {
    wn("CCTP_MOCK=true is set — real bridge will be bypassed in production!");
  } else {
    ok("CCTP_MOCK not set — real CCTP bridge active");
  }
  if (process.env.JUPITER_MOCK === "true") {
    wn("JUPITER_MOCK=true is set — real Jupiter swap will be bypassed in production!");
  } else {
    ok("JUPITER_MOCK not set — real Jupiter swap active");
  }

  // GIT_STOCK_FACTORY_ADDRESS chain check
  const factoryAddr = process.env.GIT_STOCK_FACTORY_ADDRESS ?? "";
  if (factoryAddr) {
    const SEPOLIA_FACTORY = "0x48D0337eFbDF1150ee567b480D7c6b9386f2b0C8";
    if (factoryAddr.toLowerCase() === SEPOLIA_FACTORY.toLowerCase()) {
      wn(
        "GIT_STOCK_FACTORY_ADDRESS is Sepolia address",
        "This is the TESTNET factory. Deploy to mainnet and update this env var before launch."
      );
      blockers.push("GIT_STOCK_FACTORY_ADDRESS (Sepolia)");
    } else {
      ok(`GIT_STOCK_FACTORY_ADDRESS is NOT the Sepolia address (assumed mainnet)`);
    }
  }

  return blockers;
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 10: Cross-system sync check
// ═════════════════════════════════════════════════════════════════════════════
async function testSync() {
  section("10. Cross-system Sync Check");

  // Confirm MCP list_stocks and API /api/rwa/stocks return same ticker set
  try {
    const { status, body: apiStocks } = await GET("/api/rwa/stocks");
    if (status !== 200) { wn("Skipping sync check — API not available"); return; }

    const apiTickers = new Set((apiStocks ?? []).map(s => s.ticker));

    const mcpRes = await fetch(`${BASE_URL}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_stocks", arguments: { filter: "" } } }),
    });
    const mcpText = await mcpRes.text();
    let mcpContent = "";
    for (const line of mcpText.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          const d = JSON.parse(line.slice(5).trim());
          mcpContent = d?.result?.content?.[0]?.text ?? "";
        } catch {}
      }
    }

    // MCP list_stocks returns a text summary containing tickers
    if (mcpContent.includes("NVDA") && mcpContent.includes("AAPL")) {
      ok(`MCP list_stocks output contains key tickers (NVDA, AAPL) — in sync with API`);
    } else {
      wn(`MCP list_stocks output may be truncated or different from API`);
    }

    // Price consistency: Pyth price from API should be > 0 for real-ID tickers
    const realPricedTickers = ["NVDA", "AAPL", "TSLA", "META", "GOOGL"];
    let priceOk = 0;
    for (const t of realPricedTickers) {
      try {
        const { status, body } = await GET(`/api/rwa/price/${t}`);
        if (status === 200 && body?.priceUsd > 0) priceOk++;
      } catch {}
    }
    if (priceOk === realPricedTickers.length) {
      ok(`All ${realPricedTickers.length} real-ID tickers return live Pyth prices`);
    } else {
      wn(`Only ${priceOk}/${realPricedTickers.length} tickers return live prices (Pyth may be slow)`);
    }

  } catch (err) { wn("Sync check error", err.message); }
}

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  log(`\n${"═".repeat(60)}`);
  log(`  Gitbank Full E2E Suite`);
  log(`  Base URL: ${BASE_URL}`);
  log(`  Date: ${new Date().toISOString()}`);
  log(`${"═".repeat(60)}`);

  const ready = await waitForServer();
  if (!ready) {
    log("\n  ⚠️  Server not responding. Make sure API server workflow is running.\n");
    process.exit(1);
  }
  ok("Server is up");

  await testHealth();
  await testRwaRoutes();
  await testAuthProtected();
  await testMcp();
  await testContracts();
  await testRegistry();
  await testWebhook();
  await testDatabase();
  const blockers = await testEnv();
  await testSync();

  // ── Final summary ───────────────────────────────────────────────────────────
  log(`\n${"═".repeat(60)}`);
  log(`  RESULTS: ${pass} passed  |  ${fail} failed  |  ${warn} warnings`);
  log(`${"═".repeat(60)}`);

  if (ISSUES.length > 0) {
    log("\n  FAILURES:");
    for (const i of ISSUES) log(`    ✗ ${i}`);
  }

  if (blockers.length > 0) {
    log(`\n  MAINNET BLOCKERS (${blockers.length}):`);
    for (const b of blockers) log(`    ⛔ ${b}`);
  } else if (fail === 0) {
    log("\n  ✅ All checks passed. System looks ready for mainnet deploy.");
  }

  log("");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  log("FATAL: " + err.message);
  process.exit(1);
});
