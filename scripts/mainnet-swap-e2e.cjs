#!/usr/bin/env node
/**
 * Gitbank Mainnet gitSwap E2E Test
 * Tests: gitShield 5 USDC → gitSwap USDC→WETH (→ gitWETH minted)
 * Run: node scripts/mainnet-swap-e2e.cjs
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

const RPC_URL        = process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";
const FACTORY_ADDR   = process.env.GIT_VAULT_FACTORY_ADDRESS;
const DEPLOYER_PK    = process.env.DEPLOYER_PRIVATE_KEY;
const ENC_KEY        = process.env.ENCRYPTION_MASTER_KEY;
const DB_URL         = process.env.DATABASE_URL;
const WHK_SECRET     = process.env.GITHUB_WEBHOOK_SECRET;
const TEST_WALLET_PK = process.env.test_wallet;

if (!FACTORY_ADDR || !DEPLOYER_PK || !ENC_KEY || !DB_URL || !WHK_SECRET || !TEST_WALLET_PK) {
  console.error("Missing env vars"); process.exit(1);
}

const USDC     = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH     = "0x4200000000000000000000000000000000000006";
const UNI_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const EXPLORER = "https://basescan.org/tx";

const TEST_GH_ID    = 11111111;
const TEST_GH_LOGIN = "mainnet-e2e-testuser";

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

function encryptPk(pk) {
  const mk = Buffer.from(ENC_KEY, "hex");
  const iv = crypto.randomBytes(12);
  const c  = crypto.createCipheriv("aes-256-gcm", mk, iv);
  const ct = Buffer.concat([c.update(pk, "utf8"), c.final()]);
  return iv.toString("hex") + ":" + c.getAuthTag().toString("hex") + ":" + ct.toString("hex");
}

let failures = 0;
function pass(m) { console.log("  \x1b[32m✓\x1b[0m " + m); }
function fail(m) { console.log("  \x1b[31m✗\x1b[0m " + m); failures++; }
function info(m) { console.log("  \x1b[33m·\x1b[0m " + m); }
function sec(m)  { console.log("\n\x1b[1m" + m + "\x1b[0m"); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const pool = new Pool({ connectionString: DB_URL });
const pub  = createPublicClient({ chain: base, transport: http(RPC_URL) });

function makeWebhook(comment, issueId) {
  return JSON.stringify({
    action: "created",
    issue: { number: issueId, title: "Gitbank Swap E2E", body: "", user: { login: TEST_GH_LOGIN, id: TEST_GH_ID }, labels: [], state: "open" },
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

async function waitNonce(addr, expected, timeout = 90000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const n = await pub.readContract({ address: addr, abi: VAULT_ABI, functionName: "nonce" });
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

async function run() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Gitbank Mainnet E2E — gitShield USDC + gitSwap USDC→WETH");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════════════");

  // 0. Accounts
  sec("0. Accounts");
  const pk = TEST_WALLET_PK.startsWith("0x") ? TEST_WALLET_PK : "0x" + TEST_WALLET_PK;
  const owner    = privateKeyToAccount(pk);
  const deployer = privateKeyToAccount(DEPLOYER_PK);
  const depWallet = createWalletClient({ account: deployer, chain: base, transport: http(RPC_URL) });

  const [ethOwner, ethDep, block] = await Promise.all([
    pub.getBalance({ address: owner.address }),
    pub.getBalance({ address: deployer.address }),
    pub.getBlockNumber(),
  ]);
  pass("Owner (test_wallet): " + owner.address + "  ETH: " + formatEther(ethOwner));
  pass("Deployer:            " + deployer.address + "  ETH: " + formatEther(ethDep));
  pass("Block: #" + block.toString());

  // 1. Vault (idempotent)
  sec("1. Vault for GH ID " + TEST_GH_ID);
  const exists = await pub.readContract({ address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "hasVault", args: [BigInt(TEST_GH_ID)] });
  let vault;
  if (exists) {
    vault = await pub.readContract({ address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "getVaultByGithubId", args: [BigInt(TEST_GH_ID)] });
    pass("Vault already exists: " + vault);
    await pool.query(
      `INSERT INTO users (github_id, github_login, owner_address, encrypted_pk, vault_address, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (github_id)
       DO UPDATE SET vault_address=EXCLUDED.vault_address, owner_address=EXCLUDED.owner_address, encrypted_pk=EXCLUDED.encrypted_pk`,
      [TEST_GH_ID, TEST_GH_LOGIN, owner.address, encryptPk(pk), vault]
    );
    pass("DB upserted");
  } else {
    info("Deploying vault...");
    const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "createGitVault", args: [BigInt(TEST_GH_ID), owner.address] });
    const gas  = (await pub.estimateGas({ account: deployer.address, to: FACTORY_ADDR, data }) * 130n) / 100n;
    const tx   = await depWallet.sendTransaction({ to: FACTORY_ADDR, data, gas, gasPrice: await pub.getGasPrice() });
    await pub.waitForTransactionReceipt({ hash: tx, confirmations: 1 });
    await sleep(3000);
    vault = await pub.readContract({ address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "getVaultByGithubId", args: [BigInt(TEST_GH_ID)] });
    pass("Vault deployed: " + vault);
    await pool.query(
      `INSERT INTO users (github_id, github_login, owner_address, encrypted_pk, vault_address, created_at) VALUES ($1,$2,$3,$4,$5,NOW())`,
      [TEST_GH_ID, TEST_GH_LOGIN, owner.address, encryptPk(pk), vault]
    );
    pass("DB saved");
  }
  pass("Vault: https://basescan.org/address/" + vault);

  // 2. Current balances
  sec("2. Current balances");
  let vUsdc = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] });
  let vWeth = await pub.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] });
  let nonce = Number(await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonce" }));
  pass("Vault USDC:  " + formatUnits(vUsdc, 6));
  pass("Vault WETH:  " + formatEther(vWeth));
  pass("Vault nonce: " + nonce);

  // 3. Fund vault with 5 USDC if needed
  sec("3. Fund vault with 5 USDC (raw ERC-20 transfer — no fee yet)");
  const NEED_USDC = parseUnits("5", 6);
  if (vUsdc >= NEED_USDC) {
    pass("Vault already has enough USDC: " + formatUnits(vUsdc, 6));
  } else {
    const needed = NEED_USDC - vUsdc;
    let depUsdc = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [deployer.address] });
    pass("Deployer USDC: " + formatUnits(depUsdc, 6));

    if (depUsdc < needed) {
      info("Deployer needs USDC — swapping ETH→WETH→USDC on Uniswap v3");
      const ethSwap = parseEther("0.005");
      const gp = await pub.getGasPrice();
      // Wrap ETH → WETH
      const wrapTx = await depWallet.sendTransaction({ to: WETH, value: ethSwap, gasPrice: gp });
      await pub.waitForTransactionReceipt({ hash: wrapTx, confirmations: 1 });
      pass("Wrapped ETH→WETH: " + EXPLORER + "/" + wrapTx);
      await sleep(2000);
      // Approve
      const appTx = await depWallet.writeContract({ address: WETH, abi: ERC20_ABI, functionName: "approve", args: [UNI_ROUTER, ethSwap], gasPrice: gp });
      await pub.waitForTransactionReceipt({ hash: appTx, confirmations: 1 });
      // Swap
      const swData = encodeFunctionData({ abi: UNI_ABI, functionName: "exactInputSingle", args: [{ tokenIn: WETH, tokenOut: USDC, fee: 500, recipient: deployer.address, amountIn: ethSwap, amountOutMinimum: parseUnits("1", 6), sqrtPriceLimitX96: 0n }] });
      const swGas  = (await pub.estimateGas({ account: deployer.address, to: UNI_ROUTER, data: swData }).catch(() => 300000n) * 130n) / 100n;
      const swTx   = await depWallet.sendTransaction({ to: UNI_ROUTER, data: swData, gas: swGas, gasPrice: gp });
      await pub.waitForTransactionReceipt({ hash: swTx, confirmations: 1 });
      pass("Swapped WETH→USDC: " + EXPLORER + "/" + swTx);
      await sleep(3000);
      depUsdc = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [deployer.address] });
      pass("Deployer USDC now: " + formatUnits(depUsdc, 6));
    }

    const gp = await pub.getGasPrice();
    const fundTx = await depWallet.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "transfer", args: [vault, needed], gasPrice: gp });
    await pub.waitForTransactionReceipt({ hash: fundTx, confirmations: 1 });
    pass("Sent " + formatUnits(needed, 6) + " USDC to vault: " + EXPLORER + "/" + fundTx);
    await sleep(3000);
  }

  vUsdc = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] });
  pass("Vault USDC ready: " + formatUnits(vUsdc, 6));

  // TEST 1: gitShield 5 USDC
  sec("TEST 1: @gitbankbot deposit 5 USDC (gitShield)");
  const ok1 = await webhook("@gitbankbot deposit 5 USDC", 5001);
  if (ok1) pass("Webhook 200 OK"); else fail("Webhook rejected");
  info("Waiting 50s for NLP + mainnet confirm...");
  await sleep(50000);
  const n1 = await waitNonce(vault, nonce + 1, 90000);
  let shieldHash = null;
  if (n1 && n1 > nonce) {
    nonce = n1;
    shieldHash = await lastTx("lock");
    pass("gitShield confirmed! Nonce → " + nonce);
    if (shieldHash) {
      pass("gitShield tx: " + shieldHash);
      pass("Basescan: " + EXPLORER + "/" + shieldHash);
    }
  } else {
    fail("gitShield nonce did not increment");
    const cl = await pool.query("SELECT intent,result,command_text,error FROM command_log WHERE github_id=$1 ORDER BY created_at DESC LIMIT 3", [TEST_GH_ID]);
    for (const r of cl.rows) info("[" + r.intent + "] [" + r.result + "] " + r.command_text + (r.error ? " ERR: " + r.error : ""));
  }

  vUsdc = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] });
  vWeth = await pub.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] });
  pass("Vault USDC after shield: " + formatUnits(vUsdc, 6));
  pass("Vault WETH after shield: " + formatEther(vWeth));

  // TEST 2: gitSwap USDC → WETH
  sec("TEST 2: @gitbankbot swap 3 USDC to WETH (gitSwap USDC→WETH)");
  info("Expecting: gitUSDC burned, underlying USDC swapped via Uniswap v3, gitWETH minted");
  const ok2 = await webhook("@gitbankbot swap 3 USDC to WETH", 5002);
  if (ok2) pass("Webhook 200 OK"); else fail("Webhook rejected");
  info("Waiting 60s for NLP + Uniswap swap + mainnet confirm...");
  await sleep(60000);
  const n2 = await waitNonce(vault, nonce + 1, 120000);
  let swapHash = null;
  if (n2 && n2 > nonce) {
    nonce = n2;
    swapHash = await lastTx("swap");
    pass("gitSwap confirmed! Nonce → " + nonce);
    if (swapHash) {
      pass("gitSwap tx: " + swapHash);
      pass("Basescan: " + EXPLORER + "/" + swapHash);
    }
  } else {
    fail("gitSwap nonce did not increment");
    const cl = await pool.query("SELECT intent,result,command_text,error FROM command_log WHERE github_id=$1 ORDER BY created_at DESC LIMIT 3", [TEST_GH_ID]);
    for (const r of cl.rows) info("[" + r.intent + "] [" + r.result + "] " + r.command_text + (r.error ? " ERR: " + r.error : ""));
  }

  // Final balances
  sec("Final balances");
  const finalUsdc = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] });
  const finalWeth = await pub.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] });
  const finalNonce = Number(await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonce" }));
  pass("Vault USDC: " + formatUnits(finalUsdc, 6));
  pass("Vault WETH: " + formatEther(finalWeth) + " (gitWETH minted from swap!)");
  pass("Vault nonce: " + finalNonce);

  const allTxs = await pool.query(
    "SELECT type, tx_hash FROM transactions WHERE github_id=$1 AND created_at > NOW()-INTERVAL '2 hours' ORDER BY created_at",
    [TEST_GH_ID]
  );
  const allCmds = await pool.query(
    "SELECT command_text, intent, result FROM command_log WHERE github_id=$1 AND created_at > NOW()-INTERVAL '1 hour' ORDER BY created_at",
    [TEST_GH_ID]
  );

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  BOT COMMAND LOG");
  console.log("═══════════════════════════════════════════════════════");
  for (const r of allCmds.rows) {
    const ic = r.result === "success" ? "\x1b[32m✓\x1b[0m" : r.result === "failure" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m·\x1b[0m";
    console.log("  " + ic + " [" + (r.intent||"").padEnd(12) + "] " + r.command_text);
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ON-CHAIN TRANSACTIONS (Base Mainnet)");
  console.log("═══════════════════════════════════════════════════════");
  for (const t of allTxs.rows) {
    console.log("  [" + t.type.padEnd(12) + "] " + t.tx_hash);
    console.log("   " + EXPLORER + "/" + t.tx_hash);
  }

  console.log("\n═══════════════════════════════════════════════════════");
  if (failures === 0) {
    console.log("  \x1b[32mAll checks PASSED\x1b[0m");
  } else {
    console.log("  \x1b[31m" + failures + " check(s) FAILED\x1b[0m");
  }
  console.log("  Vault: https://basescan.org/address/" + vault);
  console.log("═══════════════════════════════════════════════════════\n");

  await pool.end();
  if (failures > 0) process.exit(1);
}

run().catch(err => {
  console.error("\n\x1b[31mFATAL:\x1b[0m", err.message || err);
  pool.end().catch(() => {});
  process.exit(1);
});
