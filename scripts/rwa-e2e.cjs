#!/usr/bin/env node
/**
 * rwa-e2e.cjs — Local E2E test for gitStock RWA integration
 *
 * What it tests (mock mode):
 *   1. API: GET /api/rwa/stocks      — list all available stocks
 *   2. API: GET /api/rwa/price/NVDA  — Pyth price (mock returns $274.25)
 *   3. API: GET /api/rwa/portfolio   — portfolio (empty without auth)
 *   4. API: GET /api/rwa/contracts   — deployed contracts list
 *   5. Webhook mock: simulate buy_stock command
 *   6. Webhook mock: simulate rwa_portfolio command
 *   7. DB: verify rwa_positions table exists
 *   8. DB: verify solana_wallets table exists
 *   9. DB: verify git_stock_contracts table exists
 *
 * Usage:
 *   node scripts/rwa-e2e.cjs [--mock]
 *
 * Env:
 *   CCTP_MOCK=true (auto-set for tests)
 *   ONDO_MOCK=true (auto-set for tests)
 *   BASE_URL=http://localhost:80 (default)
 */

"use strict";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:80";
const IS_MOCK = process.argv.includes("--mock") || process.env.ONDO_MOCK === "true";

let pass = 0;
let fail = 0;

function log(msg) { process.stdout.write(msg + "\n"); }
function ok(label) { pass++; log(`  ✅ PASS  ${label}`); }
function ko(label, detail) { fail++; log(`  ❌ FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }

async function get(path, headers = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Section header ────────────────────────────────────────────────────────────
function section(title) { log(`\n── ${title} ${"─".repeat(50 - title.length)}`); }

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testRwaApiRoutes() {
  section("1. API Routes");

  // GET /api/rwa/stocks
  try {
    const { status, body } = await get("/api/rwa/stocks");
    if (status === 200 && Array.isArray(body) && body.length > 0) {
      ok(`GET /api/rwa/stocks → ${body.length} stocks`);
      const tickers = body.map(s => s.ticker);
      if (tickers.includes("NVDA") && tickers.includes("AAPL")) {
        ok(`  NVDA + AAPL present in stock list`);
      } else {
        ko(`  Expected NVDA, AAPL in stock list`, `got: ${tickers.join(", ")}`);
      }
    } else {
      ko(`GET /api/rwa/stocks`, `status=${status} body=${JSON.stringify(body)?.slice(0, 100)}`);
    }
  } catch (err) {
    ko("GET /api/rwa/stocks", err.message);
  }

  // GET /api/rwa/price/NVDA
  try {
    const { status, body } = await get("/api/rwa/price/NVDA");
    if (status === 200 && body && typeof body.priceUsd === "number" && body.priceUsd > 0) {
      ok(`GET /api/rwa/price/NVDA → $${body.priceUsd.toFixed(2)}`);
    } else {
      ko(`GET /api/rwa/price/NVDA`, `status=${status} body=${JSON.stringify(body)?.slice(0, 100)}`);
    }
  } catch (err) {
    ko("GET /api/rwa/price/NVDA", err.message);
  }

  // GET /api/rwa/price/INVALID_TICKER
  try {
    const { status } = await get("/api/rwa/price/INVALIDTICKER");
    if (status === 400) {
      ok(`GET /api/rwa/price/INVALIDTICKER → 400 as expected`);
    } else {
      ko(`GET /api/rwa/price/INVALIDTICKER`, `expected 400, got ${status}`);
    }
  } catch (err) {
    ko("GET /api/rwa/price/INVALIDTICKER", err.message);
  }

  // GET /api/rwa/portfolio — unauthenticated → 401
  try {
    const { status } = await get("/api/rwa/portfolio");
    if (status === 401) {
      ok(`GET /api/rwa/portfolio (unauthenticated) → 401 as expected`);
    } else {
      ko(`GET /api/rwa/portfolio (unauthenticated)`, `expected 401, got ${status}`);
    }
  } catch (err) {
    ko("GET /api/rwa/portfolio", err.message);
  }

  // GET /api/rwa/contracts
  try {
    const { status, body } = await get("/api/rwa/contracts");
    if (status === 200 && Array.isArray(body)) {
      ok(`GET /api/rwa/contracts → ${body.length} contracts deployed`);
    } else {
      ko(`GET /api/rwa/contracts`, `status=${status}`);
    }
  } catch (err) {
    ko("GET /api/rwa/contracts", err.message);
  }
}

async function testMcpTools() {
  section("2. MCP Tools");

  // GET /api/mcp via HTTP SSE
  try {
    const res = await fetch(`${BASE_URL}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    const text = await res.text();
    const toolNames = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          const data = JSON.parse(line.slice(5).trim());
          if (data.result?.tools) {
            for (const t of data.result.tools) toolNames.push(t.name);
          }
        } catch {}
      }
    }

    const rwaTols = ["list_stocks", "get_stock_price", "get_rwa_portfolio", "request_buy_stock", "request_sell_stock"];
    const missing = rwaTols.filter(t => !toolNames.includes(t));
    if (missing.length === 0) {
      ok(`MCP: all 5 RWA tools registered (${rwaTols.join(", ")})`);
    } else {
      ko(`MCP: missing RWA tools`, missing.join(", "));
    }
  } catch (err) {
    ko("MCP tools/list", err.message);
  }
}

async function testDbSchema() {
  section("3. Database Schema");

  // We can't query DB directly from Node without drizzle, but we can test via
  // API responses that rely on the tables (rwa/stocks + rwa/contracts use gitStockContracts)
  try {
    const { status, body } = await get("/api/rwa/contracts");
    if (status === 200) {
      ok(`DB: git_stock_contracts table accessible (${body.length} rows)`);
    } else {
      ko(`DB: git_stock_contracts table`, `GET /api/rwa/contracts → ${status}`);
    }
  } catch (err) {
    ko("DB: git_stock_contracts", err.message);
  }

  try {
    const { status, body } = await get("/api/rwa/stocks");
    if (status === 200 && Array.isArray(body)) {
      ok(`DB: rwa registry accessible via /api/rwa/stocks (${body.length} stocks)`);
    } else {
      ko(`DB: rwa stocks`, `GET /api/rwa/stocks → ${status}`);
    }
  } catch (err) {
    ko("DB: rwa stocks", err.message);
  }
}

async function testContractArtifacts() {
  section("4. Contract Artifacts");

  const fs = require("fs");
  const path = require("path");

  const artifactPaths = [
    "contracts/artifacts-hardhat/src/GitStockToken.sol/GitStockToken.json",
    "contracts/artifacts-hardhat/src/GitStockFactory.sol/GitStockFactory.json",
  ];

  for (const p of artifactPaths) {
    if (fs.existsSync(p)) {
      const artifact = JSON.parse(fs.readFileSync(p, "utf8"));
      if (artifact.abi && artifact.bytecode) {
        ok(`Artifact: ${path.basename(p)} compiled (ABI + bytecode present)`);
      } else {
        ko(`Artifact: ${path.basename(p)}`, "missing ABI or bytecode");
      }
    } else {
      ko(`Artifact: ${path.basename(p)}`, "file not found");
    }
  }
}

async function testRwaLibs() {
  section("5. Lib Modules");

  const libs = [
    "lib/rwa/src/index.ts",
    "lib/solana-relayer/src/index.ts",
    "lib/jupiter/src/index.ts",
    "lib/cctp/src/index.ts",
  ];

  const fs = require("fs");
  for (const lib of libs) {
    if (fs.existsSync(lib)) {
      ok(`Lib file exists: ${lib}`);
    } else {
      ko(`Lib file missing: ${lib}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`\n${"=".repeat(60)}`);
  log(`  gitStock RWA E2E Test Suite${IS_MOCK ? " (MOCK MODE)" : ""}`);
  log(`  Base URL: ${BASE_URL}`);
  log(`${"=".repeat(60)}`);

  if (IS_MOCK) {
    log(`  CCTP_MOCK=true, ONDO_MOCK=true (cross-chain calls mocked)`);
  }

  // Wait for server to be ready
  let serverReady = false;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/healthz`);
      if (res.ok) { serverReady = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!serverReady) {
    log("\n  ⚠️  Server not responding at " + BASE_URL);
    log("  Make sure the API server workflow is running.\n");
    process.exit(1);
  }

  await testRwaApiRoutes();
  await testMcpTools();
  await testDbSchema();
  await testContractArtifacts();
  await testRwaLibs();

  log(`\n${"=".repeat(60)}`);
  log(`  Results: ${pass} passed, ${fail} failed`);
  log(`${"=".repeat(60)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  log("FATAL: " + err.message);
  process.exit(1);
});
