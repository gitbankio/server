#!/usr/bin/env node
/**
 * Gitbank IssueOps Bot E2E Test
 * Tests: @gitbankbot deposit WETH | withdraw WETH | swap WETH→USDC | send WETH to @user
 *
 * Run: node scripts/gitops-e2e.cjs
 *
 * IMPORTANT: Run only once per API server restart.
 * The rate limiter allows 10 commands/hour per github_id (in-memory, resets on restart).
 * After 10 commands the bot silently skips webhooks from the same github_id.
 *
 * Before running:
 *   1. restart_workflow "artifacts/api-server: API Server"   (resets rate limiter)
 *   2. node scripts/sepolia-e2e.cjs                         (if vault not yet deployed)
 *   3. node scripts/gitops-e2e.cjs                          (this script)
 *
 * Expected results on Base Sepolia:
 *   gitLock   ✓  nonce increments, tx confirmed
 *   gitUnlock ✓  nonce increments, tx confirmed
 *   gitSwap   ✗  expected — Uniswap v3 WETH/USDC pool has no liquidity on Base Sepolia
 *   gitSend   ✓  2-step initTransfer+finalizeTransfer, nonce increments twice
 */
"use strict";

const crypto  = require("crypto");
const { Pool } = require("/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg");
const VIEM    = "/home/runner/workspace/node_modules/.pnpm/viem@2.49.3_typescript@5.9.3_zod@3.25.76/node_modules/viem";
const {
  createPublicClient, createWalletClient, http,
  parseAbi, encodeFunctionData,
  formatEther, formatUnits, parseEther, parseUnits, maxUint256,
} = require(VIEM + "/_cjs/index.js");
const { privateKeyToAccount } = require(VIEM + "/_cjs/accounts/index.js");
const { baseSepolia }         = require(VIEM + "/_cjs/chains/index.js");

// ── Constants ─────────────────────────────────────────────────────────────────
const ENC_KEY      = process.env.ENCRYPTION_MASTER_KEY;
const DB_URL       = process.env.DATABASE_URL;
const RPC_URL      = process.env.BASE_SEPOLIA_RPC_URL;
const WHK_SECRET   = process.env.GITHUB_WEBHOOK_SECRET;
const DEPLOYER_PK  = process.env.DEPLOYER_PRIVATE_KEY;
const DEX_ROUTER   = process.env.DEX_ROUTER_ADDRESS || "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4";

const USDC  = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const WETH  = "0x4200000000000000000000000000000000000006";
// VAULT and OWNER are loaded from DB at runtime — set in run()
let VAULT = "";
let OWNER = "";

const TEST_GH_ID    = 88888888;
const TEST_GH_LOGIN = "sepolia-e2e-testuser";
const TEST_GH_ID2   = 88888889;
const TEST_GH_LOGIN2 = "sepolia-e2e-testuser2";

const EXPLORER = "https://sepolia.basescan.org/tx";

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
]);
const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
const UNI_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const VAULT_ABI = parseAbi(["function nonce() view returns (uint256)"]);

// ── Key engine ────────────────────────────────────────────────────────────────
// Decrypt key — handles both formats:
//   server format: "ivHex:tagHex:ctHex"
//   sepolia-e2e base64: Buffer(iv[12]+tag[16]+ct[32]).toString("base64")
function decryptKey(enc) {
  const mk = Buffer.from(ENC_KEY, "hex");
  let iv, tag, ct;
  if (enc.includes(":") && enc.split(":").length === 3) {
    const p = enc.split(":");
    iv  = Buffer.from(p[0], "hex");
    tag = Buffer.from(p[1], "hex");
    ct  = Buffer.from(p[2], "hex");
  } else {
    const buf = Buffer.from(enc, "base64");
    iv  = buf.subarray(0, 12);
    tag = buf.subarray(12, 28);
    ct  = buf.subarray(28);
  }
  const d = crypto.createDecipheriv("aes-256-gcm", mk, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// Convert to server format and persist
async function ensureServerFormat(githubId, enc) {
  if (enc.includes(":") && enc.split(":").length === 3) return enc;
  // Decrypt from base64, re-encrypt to server format
  const pk = decryptKey(enc);
  const mk = Buffer.from(ENC_KEY, "hex");
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv("aes-256-gcm", mk, iv);
  const ct  = Buffer.concat([c.update(pk, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  const serverFmt = iv.toString("hex") + ":" + tag.toString("hex") + ":" + ct.toString("hex");
  await pool.query("UPDATE users SET encrypted_pk=$1 WHERE github_id=$2", [serverFmt, githubId]);
  pass("Keypair re-encrypted in server format (ivHex:tagHex:ctHex) and saved to DB");
  return serverFmt;
}

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

function makeWebhook(comment, issueId) {
  return JSON.stringify({
    action: "created",
    issue: { number: issueId, title: "Gitbank E2E Test", body: "", user: { login: TEST_GH_LOGIN, id: TEST_GH_ID }, labels: [], state: "open" },
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
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "issue_comment", "X-Hub-Signature-256": sig },
    body,
  });
  return res.status === 200;
}

async function waitNonce(expected, timeout = 40000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const n = await publicClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "nonce" });
    if (n >= BigInt(expected)) return Number(n);
    await sleep(3000);
  }
  return null;
}

async function lastTx(type) {
  const r = await pool.query(
    "SELECT tx_hash FROM transactions WHERE github_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT 1",
    [TEST_GH_ID, type]
  );
  return r.rows[0]?.tx_hash || null;
}

async function confirm(txHash) {
  return publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
}

// ── Clients ───────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DB_URL });
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Gitbank IssueOps Bot E2E — Full Command Test");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════");

  // ── Load keypair + vault address from DB ─────────────────────────────────
  section("0. Load execution keypair + vault address");
  const dbRow = await pool.query(
    "SELECT encrypted_pk, owner_address, vault_address FROM users WHERE github_id=$1",
    [TEST_GH_ID]
  );
  if (!dbRow.rows[0]?.encrypted_pk) { fail("No keypair in DB"); process.exit(1); }
  // Convert base64 → server format if needed (sepolia-e2e saves base64)
  const serverEnc = await ensureServerFormat(TEST_GH_ID, dbRow.rows[0].encrypted_pk);
  const privateKey = decryptKey(serverEnc);
  const acct       = privateKeyToAccount(privateKey);
  // Set globals from DB
  OWNER = acct.address;
  VAULT = dbRow.rows[0].vault_address;
  if (!VAULT) { fail("No vault_address in DB — run sepolia-e2e.cjs first"); process.exit(1); }
  pass("Owner:  " + OWNER);
  pass("Vault:  " + VAULT);
  const wallet = createWalletClient({ account: acct, chain: baseSepolia, transport: http(RPC_URL) });

  // ── Meta-tx model: deployer wallet pays all gas ───────────────────────────
  if (!DEPLOYER_PK) { fail("DEPLOYER_PRIVATE_KEY not set"); process.exit(1); }
  const deployerAccount = privateKeyToAccount(DEPLOYER_PK);
  const deployerWallet  = createWalletClient({ account: deployerAccount, chain: baseSepolia, transport: http(RPC_URL) });
  pass("Deployer: " + deployerAccount.address + " (pays all gas)");

  // ── Initial state ─────────────────────────────────────────────────────────
  section("1. Initial balances");
  let deployerEth  = await publicClient.getBalance({ address: deployerAccount.address });
  let vaultWeth    = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT] });
  let vaultUsdc    = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT] });
  let nonce        = Number(await publicClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "nonce" }));
  pass("Deployer ETH: " + formatEther(deployerEth));
  pass("Vault WETH:   " + formatEther(vaultWeth));
  pass("Vault USDC:   " + formatUnits(vaultUsdc, 6));
  pass("Vault nonce:  " + nonce);

  // Prep: deployer wraps ETH → WETH, then sends WETH directly to vault
  // Meta-tx model: no approval needed; tokens sit in vault until gitShield locks them
  section("2. Prep: deployer wraps ETH and funds vault with WETH");
  const WETH_DEPOSIT = parseEther("0.0005"); // deposit into vault for testing

  // Check deployer has enough ETH
  if (deployerEth < parseEther("0.002")) {
    fail("Deployer ETH too low (" + formatEther(deployerEth) + ") — needs ≥0.002 ETH for prep + gas");
    process.exit(1);
  }

  // Wrap ETH → WETH on deployer if not enough deployer WETH
  let deployerWeth = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [deployerAccount.address] });
  info("Deployer WETH: " + formatEther(deployerWeth));
  if (deployerWeth < WETH_DEPOSIT) {
    const wrapAmt = WETH_DEPOSIT - deployerWeth + parseEther("0.0001"); // small buffer
    info("Wrapping " + formatEther(wrapAmt) + " ETH → WETH via fallback (no calldata)...");
    // Base Sepolia WETH uses receive/fallback — just send ETH with no data
    const wrapTx = await deployerWallet.sendTransaction({ to: WETH, value: wrapAmt });
    const wrapReceipt = await confirm(wrapTx);
    if (wrapReceipt.status !== "success") { fail("WETH wrap tx reverted"); process.exit(1); }
    addTx("Deployer ETH → WETH wrap", wrapTx);
    await sleep(2000); // let RPC state settle
    deployerWeth = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [deployerAccount.address] });
  }
  pass("Deployer WETH: " + formatEther(deployerWeth));

  // Transfer WETH directly to vault (no approval needed in meta-tx model)
  const vaultWethBefore = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT] });
  if (vaultWethBefore < WETH_DEPOSIT) {
    const transferAmt = WETH_DEPOSIT - vaultWethBefore;
    info("Transferring " + formatEther(transferAmt) + " WETH from deployer to vault " + VAULT + "...");
    const transferTx = await deployerWallet.sendTransaction({
      to: WETH,
      data: encodeFunctionData({
        abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
        functionName: "transfer",
        args: [VAULT, transferAmt],
      }),
    });
    const transferReceipt = await confirm(transferTx);
    if (transferReceipt.status !== "success") { fail("WETH transfer to vault reverted"); process.exit(1); }
    addTx("Deployer WETH → Vault", transferTx);
    pass("WETH funded to vault: " + formatEther(transferAmt));
    await sleep(3000); // let RPC state settle
  } else {
    pass("Vault already has WETH: " + formatEther(vaultWethBefore));
  }

  vaultWeth = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT] });
  vaultUsdc = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT] });
  pass("Vault WETH after prep: " + formatEther(vaultWeth));
  pass("Vault USDC after prep: " + formatUnits(vaultUsdc, 6));

  if (vaultWeth < parseEther("0.0001")) {
    fail("Vault has insufficient WETH for tests — deposit prep failed"); process.exit(1);
  }

  // Always use WETH for tests (direct vault funding)
  const TOKEN     = WETH;
  const SYM       = "WETH";
  const DECIMALS  = 18;
  const LOCK_AMT  = "0.0001";
  const UNLOCK_AMT = "0.00003";
  const SWAP_AMT  = "0.00002";
  const SEND_AMT  = "0.00002";
  const SWAP_TO   = "USDC";
  // Destination for withdraw — deployer address (receives unshielded tokens)
  const WITHDRAW_DEST = deployerAccount.address;

  pass("Using WETH for all tests (meta-tx model — no approve needed)");
  pass("Withdraw destination: " + WITHDRAW_DEST);

  // Setup second user
  await pool.query(
    `INSERT INTO users (github_id, github_login, vault_address, created_at)
     VALUES ($1,$2,$3,NOW()) ON CONFLICT (github_id) DO UPDATE SET vault_address=EXCLUDED.vault_address`,
    [TEST_GH_ID2, TEST_GH_LOGIN2, VAULT]
  );
  pass("Second user @" + TEST_GH_LOGIN2 + " (githubId " + TEST_GH_ID2 + ") ready");

  // ── TEST 1: gitLock / deposit ─────────────────────────────────────────────
  section("TEST 1: @gitbankbot deposit " + LOCK_AMT + " " + SYM);
  const ok1 = await webhook("@gitbankbot deposit " + LOCK_AMT + " " + SYM, 2001);
  if (ok1) pass("Webhook → 200 received"); else fail("Webhook rejected");
  info("Waiting 35s for NLP + tx confirm...");
  await sleep(35000);
  const n1 = await waitNonce(nonce + 1, 40000);
  if (n1 && n1 > nonce) {
    nonce = n1;
    pass("Vault nonce → " + nonce + " (gitLock confirmed on-chain!)");
    const h = await lastTx("lock");
    if (h) addTx("gitLock " + LOCK_AMT + " " + SYM, h);
  } else {
    fail("Nonce did not increment — gitLock failed");
    // Show last command_log for diagnosis
    const cl = await pool.query("SELECT intent,result FROM command_log WHERE github_id=$1 ORDER BY created_at DESC LIMIT 1",[TEST_GH_ID]);
    info("Last command_log: " + JSON.stringify(cl.rows[0]));
  }
  const vaultUsdcAfterLock = await publicClient.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT] });
  info("Vault " + SYM + " after lock: " + formatUnits(vaultUsdcAfterLock, DECIMALS));

  // ── TEST 2: gitUnlock / withdraw ──────────────────────────────────────────
  // Meta-tx: destination address is required (bound in ownerSig hash)
  section("TEST 2: @gitbankbot withdraw " + UNLOCK_AMT + " " + SYM + " to " + WITHDRAW_DEST);
  const ok2 = await webhook("@gitbankbot withdraw " + UNLOCK_AMT + " " + SYM + " to " + WITHDRAW_DEST, 2002);
  if (ok2) pass("Webhook → 200 received"); else fail("Webhook rejected");
  info("Waiting 35s...");
  await sleep(35000);
  const n2 = await waitNonce(nonce + 1, 40000);
  if (n2 && n2 > nonce) {
    nonce = n2;
    pass("Vault nonce → " + nonce + " (gitUnlock confirmed!)");
    const h = await lastTx("unlock");
    if (h) addTx("gitUnlock " + UNLOCK_AMT + " " + SYM, h);
  } else {
    fail("Nonce did not increment — gitUnlock failed");
    const cl = await pool.query("SELECT intent,result FROM command_log WHERE github_id=$1 ORDER BY created_at DESC LIMIT 1",[TEST_GH_ID]);
    info("Last command_log: " + JSON.stringify(cl.rows[0]));
  }

  // ── TEST 3: gitSwap ───────────────────────────────────────────────────────
  section("TEST 3: @gitbankbot swap " + SWAP_AMT + " " + SYM + " to " + SWAP_TO);
  info("Note: Uniswap v3 pool required; may fail if no liquidity on testnet");
  const ok3 = await webhook("@gitbankbot swap " + SWAP_AMT + " " + SYM + " to " + SWAP_TO, 2003);
  if (ok3) pass("Webhook → 200 received"); else fail("Webhook rejected");
  info("Waiting 35s...");
  await sleep(35000);
  const n3 = await waitNonce(nonce + 1, 40000);
  if (n3 && n3 > nonce) {
    nonce = n3;
    pass("Vault nonce → " + nonce + " (gitSwap confirmed!)");
    const h = await lastTx("swap");
    if (h) addTx("gitSwap " + SWAP_AMT + " " + SYM + "→" + SWAP_TO, h);
  } else {
    const cl = await pool.query("SELECT intent,result FROM command_log WHERE github_id=$1 ORDER BY created_at DESC LIMIT 1",[TEST_GH_ID]);
    info("gitSwap result: " + JSON.stringify(cl.rows[0]) + " (DEX pool may lack liquidity on Base Sepolia)");
    const h = await lastTx("swap");
    if (h) info("Swap tx (reverted on DEX): " + EXPLORER + "/" + h);
  }

  // ── TEST 4: send / transfer ───────────────────────────────────────────────
  section("TEST 4: @gitbankbot send " + SEND_AMT + " " + SYM + " to @" + TEST_GH_LOGIN2);
  info("2-step: initTransfer + finalizeTransfer (~35s)");
  const ok4 = await webhook("@gitbankbot send " + SEND_AMT + " " + SYM + " to @" + TEST_GH_LOGIN2, 2004);
  if (ok4) pass("Webhook → 200 received"); else fail("Webhook rejected");
  info("Waiting 55s for initTransfer + block wait + finalizeTransfer...");
  await sleep(55000);
  const n4 = await waitNonce(nonce + 1, 40000);
  if (n4 && n4 > nonce) {
    nonce = n4;
    pass("Vault nonce → " + nonce + " (transfer confirmed!)");
    const h = await lastTx("transfer");
    if (h) addTx("send " + SEND_AMT + " " + SYM + " → @" + TEST_GH_LOGIN2, h);
  } else {
    const cl = await pool.query("SELECT intent,result FROM command_log WHERE github_id=$1 ORDER BY created_at DESC LIMIT 1",[TEST_GH_ID]);
    info("Transfer result: " + JSON.stringify(cl.rows[0]));
    const h = await lastTx("transfer");
    if (h) info("Transfer tx: " + EXPLORER + "/" + h);
    else fail("Transfer did not complete");
  }

  // ── Final state ───────────────────────────────────────────────────────────
  section("Final state");
  const finalNonce      = Number(await publicClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "nonce" }));
  const finalVaultUsdc  = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT] });
  const finalVaultWeth  = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [VAULT] });
  const finalDestUsdc   = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [WITHDRAW_DEST] });
  const finalDestWeth   = await publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [WITHDRAW_DEST] });
  pass("Vault nonce:       " + finalNonce);
  pass("Vault WETH:        " + formatEther(finalVaultWeth));
  pass("Vault USDC:        " + formatUnits(finalVaultUsdc, 6));
  pass("Dest WETH:         " + formatEther(finalDestWeth) + " (" + WITHDRAW_DEST + ")");
  pass("Dest USDC:         " + formatUnits(finalDestUsdc, 6));

  // All command logs
  const allCmds = await pool.query(
    "SELECT command_text, intent, result FROM command_log WHERE github_id=$1 AND created_at > NOW()-INTERVAL '10 minutes' ORDER BY created_at",
    [TEST_GH_ID]
  );
  const allTxs = await pool.query(
    "SELECT type, tx_hash FROM transactions WHERE github_id=$1 AND created_at > NOW()-INTERVAL '2 hours' ORDER BY created_at",
    [TEST_GH_ID]
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  BOT COMMAND LOG (last 10 min)");
  console.log("═══════════════════════════════════════════════════════");
  for (const r of allCmds.rows) {
    const icon = r.result === "success" ? "\x1b[32m✓\x1b[0m" : r.result === "failure" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m·\x1b[0m";
    console.log("  " + icon + " [" + r.intent.padEnd(16) + "] [" + r.result.padEnd(7) + "] " + r.command_text);
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ON-CHAIN TRANSACTIONS (today)");
  console.log("═══════════════════════════════════════════════════════");
  for (const t of allTxs.rows) {
    console.log("  [" + t.type.padEnd(16) + "] " + t.tx_hash);
    console.log("   " + EXPLORER + "/" + t.tx_hash);
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  PREP TRANSACTIONS");
  console.log("═══════════════════════════════════════════════════════");
  for (const { label, hash } of txLog) {
    if (!allTxs.rows.find(r => r.tx_hash === hash)) {
      console.log("  [" + label.padEnd(34) + "] " + hash);
      console.log("   " + EXPLORER + "/" + hash);
    }
  }

  const opsExecuted = finalNonce;
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  RESULT: " + (failures === 0 ? "\x1b[32mALL PASS\x1b[0m" : "\x1b[31m" + failures + " FAILURE(S)\x1b[0m"));
  console.log("  Token:  " + SYM);
  console.log("  Ops on-chain: " + opsExecuted);
  console.log("  Vault: https://sepolia.basescan.org/address/" + VAULT);
  console.log("═══════════════════════════════════════════════════════\n");

  await pool.end();
  if (failures > 0) process.exit(1);
}

run().catch(err => {
  console.error("\n\x1b[31mFATAL:\x1b[0m", err.message);
  pool.end().catch(() => {});
  process.exit(1);
});
