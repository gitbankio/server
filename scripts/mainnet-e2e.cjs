#!/usr/bin/env node
/**
 * Gitbank Mainnet E2E Test
 * Tests: shield USDC | unshield USDC to external address
 *
 * Run: node scripts/mainnet-e2e.cjs
 *
 * Before running:
 *   1. restart_workflow "artifacts/api-server: API Server"  (resets rate limiter + picks up mainnet env)
 *   2. node scripts/mainnet-e2e.cjs
 *
 * Prep done automatically:
 *   - Deploys vault for test GH ID (mainnet) using test_wallet as owner
 *   - Deployer wraps ETH → WETH → swaps to USDC on Uniswap v3 Base mainnet
 *   - Deployer sends USDC to vault
 */
"use strict";

const crypto  = require("crypto");
const { Pool } = require("/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg");
const VIEM    = "/home/runner/workspace/node_modules/.pnpm/viem@2.49.3_typescript@5.9.3_zod@3.25.76/node_modules/viem";
const {
  createPublicClient, createWalletClient, http,
  parseAbi, encodeFunctionData,
  formatEther, formatUnits, parseEther, parseUnits,
} = require(VIEM + "/_cjs/index.js");
const { privateKeyToAccount } = require(VIEM + "/_cjs/accounts/index.js");
const { base }                = require(VIEM + "/_cjs/chains/index.js");

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL      = process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";
const FACTORY_ADDR = process.env.GIT_VAULT_FACTORY_ADDRESS; // mainnet factory
const DEPLOYER_PK  = process.env.DEPLOYER_PRIVATE_KEY;
const RELAYER_PK   = process.env.RELAYER_SIGNING_KEY;
const ENC_KEY      = process.env.ENCRYPTION_MASTER_KEY;
const DB_URL       = process.env.DATABASE_URL;
const WHK_SECRET   = process.env.GITHUB_WEBHOOK_SECRET;
const TEST_WALLET_PK = process.env.test_wallet; // owner key

if (!RPC_URL || !FACTORY_ADDR || !DEPLOYER_PK || !RELAYER_PK || !ENC_KEY || !DB_URL || !WHK_SECRET || !TEST_WALLET_PK) {
  console.error("Missing required env vars:", { RPC_URL: !!RPC_URL, FACTORY_ADDR: !!FACTORY_ADDR, DEPLOYER_PK: !!DEPLOYER_PK, RELAYER_PK: !!RELAYER_PK, ENC_KEY: !!ENC_KEY, DB_URL: !!DB_URL, WHK_SECRET: !!WHK_SECRET, TEST_WALLET_PK: !!TEST_WALLET_PK });
  process.exit(1);
}

// ── Addresses ─────────────────────────────────────────────────────────────────

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base mainnet USDC
const WETH = "0x4200000000000000000000000000000000000006"; // Base mainnet WETH
const UNI_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481"; // Uniswap v3 SwapRouter02 Base mainnet

const WITHDRAW_DEST = "0x0F16f56D7627B7a4cc825Ef1AfC2B148e15Fee6C";
const EXPLORER      = "https://basescan.org/tx";

const TEST_GH_ID    = 11111111;
const TEST_GH_LOGIN = "mainnet-e2e-testuser";

// Amounts (USDC has 6 decimals)
const USDC_FUND    = parseUnits("3", 6);   // 3 USDC to vault for testing
const USDC_SHIELD  = parseUnits("1", 6);   // shield 1 USDC
const USDC_UNSHIELD = parseUnits("0.5", 6); // unshield 0.5 USDC
const ETH_TO_SWAP  = parseEther("0.003");   // swap 0.003 ETH worth → ~7.5 USDC

// ── ABIs ──────────────────────────────────────────────────────────────────────

const FACTORY_ABI = parseAbi([
  "function createGitVault(uint256 githubUserId, address ownerAddress) returns (address vault)",
  "function getVaultByGithubId(uint256 githubUserId) view returns (address)",
  "function hasVault(uint256 githubUserId) view returns (bool)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
]);
const VAULT_ABI = parseAbi(["function nonce() view returns (uint256)"]);
const UNI_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

// ── Key engine ────────────────────────────────────────────────────────────────

function encryptPkServerFormat(pk) {
  const mk  = Buffer.from(ENC_KEY, "hex");
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv("aes-256-gcm", mk, iv);
  const ct  = Buffer.concat([c.update(pk, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + ct.toString("hex");
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
    issue: { number: issueId, title: "Gitbank Mainnet E2E", body: "", user: { login: TEST_GH_LOGIN, id: TEST_GH_ID }, labels: [], state: "open" },
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

async function waitNonce(vaultAddr, expected, timeout = 60000) {
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
    "SELECT tx_hash FROM transactions WHERE github_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT 1",
    [TEST_GH_ID, type]
  );
  return r.rows[0]?.tx_hash || null;
}

async function confirm(hash) {
  return publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
}

// ── Clients ───────────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: DB_URL });
const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Gitbank Mainnet E2E — USDC shield + unshield");
  console.log("  " + new Date().toISOString());
  console.log("  Factory: " + FACTORY_ADDR);
  console.log("═══════════════════════════════════════════════════════");

  // ── 0. Accounts ───────────────────────────────────────────────────────────
  section("0. Accounts");

  const normalizedTestPk = TEST_WALLET_PK.startsWith("0x") ? TEST_WALLET_PK : "0x" + TEST_WALLET_PK;
  const ownerAccount    = privateKeyToAccount(normalizedTestPk);
  const deployerAccount = privateKeyToAccount(DEPLOYER_PK);

  const deployerWallet = createWalletClient({ account: deployerAccount, chain: base, transport: http(RPC_URL) });

  const [ethBalOwner, ethBalDeployer, block] = await Promise.all([
    publicClient.getBalance({ address: ownerAccount.address }),
    publicClient.getBalance({ address: deployerAccount.address }),
    publicClient.getBlockNumber(),
  ]);

  pass("Owner (test_wallet): " + ownerAccount.address + " — " + formatEther(ethBalOwner) + " ETH");
  pass("Deployer:            " + deployerAccount.address + " — " + formatEther(ethBalDeployer) + " ETH");
  pass("Base mainnet RPC — block #" + block.toString());
  pass("Factory: " + FACTORY_ADDR);

  if (ethBalDeployer < parseEther("0.01")) {
    fail("Deployer ETH too low (" + formatEther(ethBalDeployer) + ") — needs ≥0.01 ETH");
    process.exit(1);
  }

  // ── 1. Vault deploy (idempotent) ──────────────────────────────────────────
  section("1. Vault deploy — test GH ID " + TEST_GH_ID);

  const vaultExists = await publicClient.readContract({
    address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "hasVault",
    args: [BigInt(TEST_GH_ID)],
  });
  info("hasVault(" + TEST_GH_ID + ") = " + vaultExists);

  let vaultAddress;

  if (vaultExists) {
    vaultAddress = await publicClient.readContract({
      address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "getVaultByGithubId",
      args: [BigInt(TEST_GH_ID)],
    });
    pass("Vault already deployed: " + vaultAddress);
    // Ensure user row exists in DB
    const encryptedPk = encryptPkServerFormat(normalizedTestPk);
    await pool.query(
      `INSERT INTO users (github_id, github_login, owner_address, encrypted_pk, vault_address, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (github_id) DO UPDATE SET vault_address=EXCLUDED.vault_address, owner_address=EXCLUDED.owner_address, encrypted_pk=EXCLUDED.encrypted_pk`,
      [TEST_GH_ID, TEST_GH_LOGIN, ownerAccount.address, encryptedPk, vaultAddress]
    );
    pass("DB user upserted");
  } else {
    pass("Deploying vault for " + ownerAccount.address + "...");
    const deployData = encodeFunctionData({
      abi: FACTORY_ABI, functionName: "createGitVault",
      args: [BigInt(TEST_GH_ID), ownerAccount.address],
    });
    const gasEst   = await publicClient.estimateGas({ account: deployerAccount.address, to: FACTORY_ADDR, data: deployData });
    const gasLimit = (gasEst * 130n) / 100n;
    const gasPrice = await publicClient.getGasPrice();
    const deployTx = await deployerWallet.sendTransaction({ to: FACTORY_ADDR, data: deployData, gas: gasLimit, gasPrice });
    info("Deploy tx: " + deployTx);
    const deployReceipt = await confirm(deployTx);
    if (deployReceipt.status !== "success") { fail("Vault deploy reverted"); process.exit(1); }
    addTx("Vault deploy", deployTx);

    await sleep(3000);
    vaultAddress = await publicClient.readContract({
      address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "getVaultByGithubId",
      args: [BigInt(TEST_GH_ID)],
    });
    pass("Vault deployed: " + vaultAddress);
    info("Basescan: https://basescan.org/address/" + vaultAddress);

    // Save to DB
    const encryptedPk = encryptPkServerFormat(normalizedTestPk);
    await pool.query("DELETE FROM users WHERE github_id=$1", [TEST_GH_ID]);
    await pool.query(
      `INSERT INTO users (github_id, github_login, owner_address, encrypted_pk, vault_address, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [TEST_GH_ID, TEST_GH_LOGIN, ownerAccount.address, encryptedPk, vaultAddress]
    );
    pass("User saved to DB — owner: " + ownerAccount.address);
  }

  // ── 2. Initial balances ───────────────────────────────────────────────────
  section("2. Initial balances");
  let [vaultUsdc, vaultWeth, depUsdc, depWeth] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [vaultAddress] }),
    publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [vaultAddress] }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [deployerAccount.address] }),
    publicClient.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [deployerAccount.address] }),
  ]);
  let nonce = Number(await publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "nonce" }));
  pass("Vault USDC:     " + formatUnits(vaultUsdc, 6));
  pass("Vault WETH:     " + formatEther(vaultWeth));
  pass("Deployer USDC:  " + formatUnits(depUsdc, 6));
  pass("Deployer WETH:  " + formatEther(depWeth));
  pass("Vault nonce:    " + nonce);

  // ── 3. Prep: fund vault with USDC ─────────────────────────────────────────
  section("3. Prep: fund vault with USDC");

  if (vaultUsdc >= USDC_FUND) {
    pass("Vault already has enough USDC: " + formatUnits(vaultUsdc, 6));
  } else {
    const needed = USDC_FUND - vaultUsdc;
    info("Vault needs " + formatUnits(needed, 6) + " more USDC");

    // Step 3a: Check deployer USDC
    if (depUsdc < needed) {
      const usdcShortfall = needed - depUsdc;
      info("Deployer needs more USDC — will swap ETH→WETH→USDC on Uniswap v3");

      // Wrap ETH → WETH
      const gasPrice = await publicClient.getGasPrice();
      info("Wrapping " + formatEther(ETH_TO_SWAP) + " ETH → WETH...");
      const wrapTx = await deployerWallet.sendTransaction({ to: WETH, value: ETH_TO_SWAP, gasPrice });
      const wrapReceipt = await confirm(wrapTx);
      if (wrapReceipt.status !== "success") { fail("WETH wrap reverted"); process.exit(1); }
      addTx("ETH→WETH wrap", wrapTx);
      await sleep(2000);

      // Approve Uniswap router to spend WETH
      info("Approving Uniswap SwapRouter02 to spend WETH...");
      const approveTx = await deployerWallet.writeContract({
        address: WETH, abi: ERC20_ABI, functionName: "approve",
        args: [UNI_ROUTER, ETH_TO_SWAP],
        gasPrice,
      });
      const approveReceipt = await confirm(approveTx);
      if (approveReceipt.status !== "success") { fail("WETH approve reverted"); process.exit(1); }
      addTx("WETH approve Uniswap", approveTx);
      await sleep(2000);

      // Swap WETH → USDC
      info("Swapping " + formatEther(ETH_TO_SWAP) + " WETH → USDC on Uniswap v3...");
      const swapData = encodeFunctionData({
        abi: UNI_ABI,
        functionName: "exactInputSingle",
        args: [{
          tokenIn: WETH,
          tokenOut: USDC,
          fee: 500,                          // 0.05% fee tier (WETH/USDC on Base)
          recipient: deployerAccount.address,
          amountIn: ETH_TO_SWAP,
          amountOutMinimum: parseUnits("1", 6), // min 1 USDC (slippage guard)
          sqrtPriceLimitX96: 0n,
        }],
      });
      const swapGasEst = await publicClient.estimateGas({ account: deployerAccount.address, to: UNI_ROUTER, data: swapData }).catch(() => 300000n);
      const swapTx = await deployerWallet.sendTransaction({ to: UNI_ROUTER, data: swapData, gas: (swapGasEst * 130n) / 100n, gasPrice });
      const swapReceipt = await confirm(swapTx);
      if (swapReceipt.status !== "success") { fail("Uniswap swap reverted"); process.exit(1); }
      addTx("WETH→USDC swap", swapTx);
      await sleep(3000);

      depUsdc = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [deployerAccount.address] });
      pass("Deployer USDC after swap: " + formatUnits(depUsdc, 6));
      if (depUsdc < needed) {
        fail("Still not enough USDC after swap: " + formatUnits(depUsdc, 6) + " < " + formatUnits(needed, 6));
        process.exit(1);
      }
    }

    // Step 3b: Transfer USDC from deployer to vault
    info("Transferring " + formatUnits(needed, 6) + " USDC to vault " + vaultAddress + "...");
    const gasPrice2 = await publicClient.getGasPrice();
    const fundTx = await deployerWallet.writeContract({
      address: USDC, abi: ERC20_ABI, functionName: "transfer",
      args: [vaultAddress, needed],
      gasPrice: gasPrice2,
    });
    const fundReceipt = await confirm(fundTx);
    if (fundReceipt.status !== "success") { fail("USDC transfer to vault reverted"); process.exit(1); }
    addTx("USDC → Vault", fundTx);
    await sleep(3000);
  }

  vaultUsdc = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [vaultAddress] });
  pass("Vault USDC ready: " + formatUnits(vaultUsdc, 6));

  if (vaultUsdc < USDC_SHIELD) {
    fail("Vault USDC insufficient for shield test"); process.exit(1);
  }

  // ── TEST 1: gitShield USDC ────────────────────────────────────────────────
  section("TEST 1: @gitbankbot deposit 1 USDC (gitShield)");
  const ok1 = await webhook("@gitbankbot deposit 1 USDC", 3001);
  if (ok1) pass("Webhook → 200 received"); else { fail("Webhook rejected"); }
  info("Waiting 45s for NLP + mainnet tx confirm...");
  await sleep(45000);
  const n1 = await waitNonce(vaultAddress, nonce + 1, 60000);
  if (n1 && n1 > nonce) {
    nonce = n1;
    pass("Vault nonce → " + nonce + " (gitShield confirmed on-chain!)");
    const h = await lastTx("lock");
    if (h) addTx("gitShield 1 USDC", h);
  } else {
    fail("Nonce did not increment — gitShield failed");
    const cl = await pool.query("SELECT intent,result,command_text FROM command_log WHERE github_id=$1 ORDER BY created_at DESC LIMIT 1", [TEST_GH_ID]);
    info("Last command_log: " + JSON.stringify(cl.rows[0]));
  }

  vaultUsdc = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [vaultAddress] });
  pass("Vault USDC after shield: " + formatUnits(vaultUsdc, 6));

  // ── TEST 2: gitUnshield USDC to destination ───────────────────────────────
  section("TEST 2: @gitbankbot withdraw 0.5 USDC to " + WITHDRAW_DEST + " (gitUnshield)");
  const destUsdcBefore = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [WITHDRAW_DEST] });
  info("Dest USDC before: " + formatUnits(destUsdcBefore, 6));

  const ok2 = await webhook("@gitbankbot withdraw 0.5 USDC to " + WITHDRAW_DEST, 3002);
  if (ok2) pass("Webhook → 200 received"); else { fail("Webhook rejected"); }
  info("Waiting 45s...");
  await sleep(45000);
  const n2 = await waitNonce(vaultAddress, nonce + 1, 60000);
  if (n2 && n2 > nonce) {
    nonce = n2;
    pass("Vault nonce → " + nonce + " (gitUnshield confirmed!)");
    const h = await lastTx("unlock");
    if (h) addTx("gitUnshield 0.5 USDC → " + WITHDRAW_DEST, h);
  } else {
    fail("Nonce did not increment — gitUnshield failed");
    const cl = await pool.query("SELECT intent,result,command_text FROM command_log WHERE github_id=$1 ORDER BY created_at DESC LIMIT 1", [TEST_GH_ID]);
    info("Last command_log: " + JSON.stringify(cl.rows[0]));
  }

  // ── Final state ───────────────────────────────────────────────────────────
  section("Final state");
  const finalNonce   = Number(await publicClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "nonce" }));
  const finalVaultUsdc = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [vaultAddress] });
  const finalDestUsdc  = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [WITHDRAW_DEST] });
  pass("Vault nonce:  " + finalNonce);
  pass("Vault USDC:   " + formatUnits(finalVaultUsdc, 6));
  pass("Dest USDC:    " + formatUnits(finalDestUsdc, 6) + " (" + WITHDRAW_DEST + ")");

  // All command logs
  const allCmds = await pool.query(
    "SELECT command_text, intent, result FROM command_log WHERE github_id=$1 AND created_at > NOW()-INTERVAL '30 minutes' ORDER BY created_at",
    [TEST_GH_ID]
  );
  const allTxs = await pool.query(
    "SELECT type, tx_hash FROM transactions WHERE github_id=$1 AND created_at > NOW()-INTERVAL '2 hours' ORDER BY created_at",
    [TEST_GH_ID]
  );

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  BOT COMMAND LOG");
  console.log("═══════════════════════════════════════════════════════");
  for (const r of allCmds.rows) {
    const icon = r.result === "success" ? "\x1b[32m✓\x1b[0m" : r.result === "failure" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m·\x1b[0m";
    console.log("  " + icon + " [" + (r.intent||"").padEnd(16) + "] [" + (r.result||"").padEnd(7) + "] " + r.command_text);
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ON-CHAIN TRANSACTIONS (Base Mainnet)");
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
      console.log("  [" + label.padEnd(30) + "] " + hash);
      console.log("   " + EXPLORER + "/" + hash);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
  if (failures === 0) {
    console.log("  \x1b[32mAll checks passed (" + failures + " failures)\x1b[0m");
  } else {
    console.log("  \x1b[31m" + failures + " check(s) FAILED\x1b[0m");
  }
  console.log("  Vault:    " + vaultAddress);
  console.log("  Basescan: https://basescan.org/address/" + vaultAddress);
  console.log("═══════════════════════════════════════════════════════\n");

  await pool.end();
  if (failures > 0) process.exit(1);
}

run().catch(err => {
  console.error("\n\x1b[31mFATAL:\x1b[0m", err.message || err);
  pool.end().catch(() => {});
  process.exit(1);
});
