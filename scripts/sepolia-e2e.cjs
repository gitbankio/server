#!/usr/bin/env node
/**
 * Gitbank Sepolia E2E Test — idempotent
 *
 * Checks on-chain state first. If vault already exists for TEST_GITHUB_ID,
 * reuses it. Only deploys if not yet deployed.
 *
 * Run: node scripts/sepolia-e2e.cjs
 */

"use strict";

const crypto  = require("crypto");
const { Pool } = require("/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg");
const VIEM    = "/home/runner/workspace/node_modules/.pnpm/viem@2.49.3_typescript@5.9.3_zod@3.25.76/node_modules/viem";
const {
  createPublicClient, createWalletClient, http,
  parseAbi, encodeFunctionData, keccak256, encodePacked,
  formatEther, parseEther, getAddress,
} = require(VIEM + "/_cjs/index.js");
const { privateKeyToAccount } = require(VIEM + "/_cjs/accounts/index.js");
const { baseSepolia }         = require(VIEM + "/_cjs/chains/index.js");

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL      = process.env.BASE_SEPOLIA_RPC_URL;
const FACTORY_ADDR = process.env.GIT_VAULT_FACTORY_ADDRESS;
const DEPLOYER_PK  = process.env.DEPLOYER_PRIVATE_KEY;
const RELAYER_PK   = process.env.RELAYER_SIGNING_KEY;
const ENC_KEY      = process.env.ENCRYPTION_MASTER_KEY;
const DB_URL       = process.env.DATABASE_URL;

const TEST_GITHUB_ID    = 88888888;
const TEST_GITHUB_LOGIN = "sepolia-e2e-testuser";
const FUND_AMOUNT       = parseEther("0.001"); // small subsidy for testing

if (!RPC_URL || !FACTORY_ADDR || !DEPLOYER_PK || !RELAYER_PK || !ENC_KEY || !DB_URL) {
  console.error("Missing required env vars"); process.exit(1);
}

const pool = new Pool({ connectionString: DB_URL });
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

const FACTORY_ABI = parseAbi([
  "function createGitVault(uint256 githubUserId, address ownerAddress) returns (address vault)",
  "function getVaultByGithubId(uint256 githubUserId) view returns (address)",
  "function hasVault(uint256 githubUserId) view returns (bool)",
]);
const VAULT_ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function owner() view returns (address)",
  "function githubUserId() view returns (uint256)",
  "function relayerSigner() view returns (address)",
]);

// ── Key engine (mirrors key-engine.ts) ────────────────────────────────────────

function encryptPrivateKey(pk) {
  const masterKey = Buffer.from(ENC_KEY, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(pk, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function generateKeypair() {
  const privateKey = "0x" + crypto.randomBytes(32).toString("hex");
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, privateKey };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let failures = 0;
function pass(msg) { console.log("  \x1b[32m✓\x1b[0m " + msg); }
function fail(msg) { console.log("  \x1b[31m✗\x1b[0m " + msg); failures++; }
function info(msg) { console.log("  \x1b[33m·\x1b[0m " + msg); }
function section(msg) { console.log("\n\x1b[1m" + msg + "\x1b[0m"); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n═══════════════════════════════════════════");
  console.log("  Gitbank Sepolia E2E Test");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════");

  // ── 1. Env + RPC ──────────────────────────────────────────────────────────
  section("1. Environment + RPC");
  const block = await publicClient.getBlockNumber();
  pass("Base Sepolia RPC — block #" + block.toString());

  const deployerAccount = privateKeyToAccount(DEPLOYER_PK);
  const relayerAccount  = privateKeyToAccount(RELAYER_PK);

  const deployerBal = await publicClient.getBalance({ address: deployerAccount.address });
  const deployerEth = formatEther(deployerBal);
  pass("Deployer " + deployerAccount.address + " — " + deployerEth + " ETH");
  pass("RelayerSigner " + relayerAccount.address + " (off-chain only, no ETH needed)");
  pass("Factory " + FACTORY_ADDR);
  pass("ENCRYPTION_MASTER_KEY — " + ENC_KEY.length + " hex chars");

  // ── 2. Check on-chain state first (idempotent) ─────────────────────────────
  section("2. On-chain vault check");
  const vaultExistsOnChain = await publicClient.readContract({
    address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "hasVault",
    args: [BigInt(TEST_GITHUB_ID)],
  });
  info("hasVault(" + TEST_GITHUB_ID + ") = " + vaultExistsOnChain);

  let vaultAddress, ownerAddress, privateKey, encryptedPk;

  if (vaultExistsOnChain) {
    // Reuse existing vault — load from DB or factory
    vaultAddress = await publicClient.readContract({
      address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "getVaultByGithubId",
      args: [BigInt(TEST_GITHUB_ID)],
    });
    pass("Vault already deployed: " + vaultAddress);

    // Try to load keypair from DB
    const dbRow = await pool.query(
      "SELECT encrypted_pk, owner_address FROM users WHERE github_id = $1", [TEST_GITHUB_ID]
    );
    if (dbRow.rows.length > 0 && dbRow.rows[0].encrypted_pk) {
      encryptedPk  = dbRow.rows[0].encrypted_pk;
      ownerAddress = dbRow.rows[0].owner_address;
      // Sync vault_address to DB if missing or zero
      if (!dbRow.rows[0].vault_address || dbRow.rows[0].vault_address === "0x0000000000000000000000000000000000000000") {
        await pool.query("UPDATE users SET vault_address = $1 WHERE github_id = $2", [vaultAddress, TEST_GITHUB_ID]);
      }
      pass("Loaded execution keypair from DB — owner " + ownerAddress);
    } else {
      info("No keypair in DB (previous test run cleaned up) — vault ops will be skipped");
      // Ensure user row exists with correct vault_address
      await pool.query(
        `INSERT INTO users (github_id, github_login, vault_address, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (github_id) DO UPDATE SET vault_address = EXCLUDED.vault_address`,
        [TEST_GITHUB_ID, TEST_GITHUB_LOGIN, vaultAddress]
      );
    }
  } else {
    // Fresh deploy needed
    pass("No vault yet — will deploy");
    if (deployerBal < parseEther("0.001")) {
      fail("Deployer balance too low (" + deployerEth + " ETH) — needs ≥0.001 ETH");
      process.exit(1);
    }

    // ── 3. DB setup ──────────────────────────────────────────────────────────
    section("3. Database — setup test user");
    await pool.query("DELETE FROM users WHERE github_id = $1", [TEST_GITHUB_ID]);
    await pool.query(
      `INSERT INTO users (github_id, github_login, created_at) VALUES ($1, $2, NOW())`,
      [TEST_GITHUB_ID, TEST_GITHUB_LOGIN]
    );
    pass("Test user inserted — githubId " + TEST_GITHUB_ID);

    // ── 4. Generate + encrypt execution keypair ──────────────────────────────
    section("4. Execution keypair");
    const kp = generateKeypair();
    ownerAddress = kp.address;
    privateKey   = kp.privateKey;
    encryptedPk  = encryptPrivateKey(privateKey);
    pass("Execution address: " + ownerAddress);
    pass("Encrypted key: " + encryptedPk.length + " chars base64");
    await pool.query(
      "UPDATE users SET owner_address = $1, encrypted_pk = $2 WHERE github_id = $3",
      [ownerAddress, encryptedPk, TEST_GITHUB_ID]
    );
    pass("Keypair saved to DB");

    // ── 5. Deploy vault on-chain (deployer pays gas, meta-tx model) ──────────
    section("5. Vault deployment — Base Sepolia (deployer pays gas)");
    info("Meta-tx model: deployer wallet submits all txs, ownerAddress signs intent only");
    const deployerWallet = createWalletClient({
      account: deployerAccount, chain: baseSepolia, transport: http(RPC_URL),
    });
    const deployData  = encodeFunctionData({
      abi: FACTORY_ABI, functionName: "createGitVault",
      args: [BigInt(TEST_GITHUB_ID), ownerAddress],
    });
    const gasEst   = await publicClient.estimateGas({ account: deployerAccount.address, to: FACTORY_ADDR, data: deployData });
    const gasLimit = (gasEst * 130n) / 100n;
    const gasPrice = await publicClient.getGasPrice();
    pass("Estimated gas: " + gasEst.toString() + " → limit " + gasLimit.toString());
    const deployTx = await deployerWallet.sendTransaction({ to: FACTORY_ADDR, data: deployData, gas: gasLimit, gasPrice });
    pass("Deploy tx: " + deployTx);
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployTx, confirmations: 1 });
    if (deployReceipt.status !== "success") { fail("Deploy tx reverted"); process.exit(1); }
    pass("Deploy confirmed — block #" + deployReceipt.blockNumber + ", gas used: " + deployReceipt.gasUsed);
    pass("Events emitted: " + deployReceipt.logs.length);

    await new Promise(r => setTimeout(r, 3000)); // RPC state settle
    vaultAddress = await publicClient.readContract({
      address: FACTORY_ADDR, abi: FACTORY_ABI, functionName: "getVaultByGithubId",
      args: [BigInt(TEST_GITHUB_ID)],
    });
    if (!vaultAddress || vaultAddress === "0x0000000000000000000000000000000000000000") {
      fail("getVaultByGithubId returned zero after deploy — factory state not updated?"); process.exit(1);
    }
    pass("Vault address: " + vaultAddress);
    await pool.query("UPDATE users SET vault_address = $1 WHERE github_id = $2", [vaultAddress, TEST_GITHUB_ID]);
    pass("Vault address saved to DB");
  }

  // ── 7. On-chain vault state ────────────────────────────────────────────────
  section("7. Vault on-chain state");
  const nonce = await publicClient.readContract({
    address: vaultAddress, abi: VAULT_ABI, functionName: "nonce",
  });
  pass("nonce() = " + nonce.toString());

  const onchainOwner = await publicClient.readContract({
    address: vaultAddress, abi: VAULT_ABI, functionName: "owner",
  });
  pass("owner() = " + onchainOwner);

  const onchainGithubId = await publicClient.readContract({
    address: vaultAddress, abi: VAULT_ABI, functionName: "githubUserId",
  });
  if (onchainGithubId === BigInt(TEST_GITHUB_ID)) pass("githubUserId() = " + onchainGithubId + " correct");
  else fail("githubUserId() = " + onchainGithubId + ", expected " + TEST_GITHUB_ID);

  const onchainRelayerSigner = await publicClient.readContract({
    address: vaultAddress, abi: VAULT_ABI, functionName: "relayerSigner",
  });
  const relayerMatch = getAddress(onchainRelayerSigner) === getAddress(relayerAccount.address);
  if (relayerMatch) pass("relayerSigner() = " + onchainRelayerSigner + " matches RELAYER_SIGNING_KEY");
  else fail("relayerSigner() " + onchainRelayerSigner + " does NOT match RELAYER_SIGNING_KEY " + relayerAccount.address);

  if (ownerAddress) {
    const ownerMatch = getAddress(onchainOwner) === getAddress(ownerAddress);
    if (ownerMatch) pass("owner() matches execution keypair in DB");
    else fail("owner() mismatch — vault owner " + onchainOwner + " vs DB keypair " + ownerAddress);
  }

  // ── 8. Dual-sig relayer signature ─────────────────────────────────────────
  section("8. Dual-sig — relayer ECDSA signature");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const msgHash  = keccak256(encodePacked(
    ["address", "uint256", "uint256"],
    [vaultAddress, BigInt(TEST_GITHUB_ID), deadline],
  ));
  const sig = await relayerAccount.signMessage({ message: { raw: msgHash } });
  pass("Sig generated (" + sig.length + " hex chars)");
  pass("Hash: " + msgHash);
  pass("Deadline: T+" + 300 + "s");
  pass("Signer: " + relayerAccount.address);

  // ── 9. API endpoints ───────────────────────────────────────────────────────
  section("9. API health checks");
  const healthRes = await fetch("http://localhost:80/api/healthz");
  const health    = await healthRes.json();
  if (health.status === "ok") pass("GET /api/healthz → " + JSON.stringify(health));
  else fail("GET /api/healthz unexpected: " + JSON.stringify(health));

  const meRes = await fetch("http://localhost:80/api/auth/me");
  if (meRes.status === 401) pass("GET /api/auth/me → 401 (no session, correct)");
  else fail("GET /api/auth/me → " + meRes.status + " (expected 401)");

  // ── 10. Webhook HMAC test ─────────────────────────────────────────────────
  section("10. Webhook HMAC + NLP");
  const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    fail("GITHUB_WEBHOOK_SECRET not set");
  } else {
    const mkPayload = (cmd, id) => JSON.stringify({
      action: "created",
      issue: { number: id, title: "E2E test", body: "test", user: { login: "testuser", id: TEST_GITHUB_ID }, labels: [], state: "open" },
      comment: { id, body: cmd, user: { login: "testuser", id: TEST_GITHUB_ID } },
      repository: { id: 1, full_name: "gitbankio/test", name: "test", owner: { login: "gitbankio", id: 1 } },
      installation: { id: 1 },
      sender: { login: "testuser", id: TEST_GITHUB_ID },
    });

    const commands = [
      { cmd: "@gitbankbot help",    id: 200 },
      { cmd: "@gitbankbot balance", id: 201 },
      { cmd: "@gitbankbot status",  id: 202 },
    ];

    for (const { cmd, id } of commands) {
      const body = mkPayload(cmd, id);
      const sig  = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
      const res  = await fetch("http://localhost:80/api/webhook/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issue_comment",
          "X-Hub-Signature-256": sig,
        },
        body,
      });
      const json = await res.json();
      if (res.status === 200 && json.message === "received")
        pass("Webhook [" + cmd + "] → 200 received");
      else
        fail("Webhook [" + cmd + "] → " + res.status + " " + JSON.stringify(json));
    }

    // Test invalid HMAC
    const badRes = await fetch("http://localhost:80/api/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issue_comment",
        "X-Hub-Signature-256": "sha256=badbadbadbad",
      },
      body: mkPayload("@gitbankbot balance", 999),
    });
    if (badRes.status === 400) pass("Webhook with bad HMAC → 400 (signature rejected correctly)");
    else fail("Webhook with bad HMAC → " + badRes.status + " (expected 400)");
  }

  // ── 11. DB final state ─────────────────────────────────────────────────────
  section("11. DB final state");
  const finalRow = await pool.query(
    "SELECT github_id, github_login, owner_address, vault_address FROM users WHERE github_id = $1",
    [TEST_GITHUB_ID]
  );
  if (finalRow.rows.length > 0) {
    const r = finalRow.rows[0];
    pass("github_id:     " + r.github_id);
    pass("github_login:  " + r.github_login);
    pass("owner_address: " + (r.owner_address || "(none — vault owned by prev run keypair)"));
    pass("vault_address: " + r.vault_address);
  } else {
    fail("No user row found in DB");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════");
  if (failures === 0) {
    console.log("  \x1b[32mAll checks passed (" + failures + " failures)\x1b[0m");
  } else {
    console.log("  \x1b[31m" + failures + " check(s) FAILED\x1b[0m");
  }
  console.log("  Vault:    " + (vaultAddress || "N/A"));
  if (vaultAddress) console.log("  Basescan: https://sepolia.basescan.org/address/" + vaultAddress);
  console.log("═══════════════════════════════════════════\n");

  await pool.end();
  if (failures > 0) process.exit(1);
}

run().catch(err => {
  console.error("\n\x1b[31mFATAL:\x1b[0m", err.message || err);
  pool.end().catch(() => {});
  process.exit(1);
});
