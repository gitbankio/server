#!/usr/bin/env node
/**
 * Gitbank — Token Launch E2E (Base Mainnet)
 *
 * Full flow:
 *   1. Deploy TEST token via Clanker v4
 *   2. Decode pool info from deploy receipt (no extra RPC calls)
 *   3. Buy 0.01 ETH worth of TEST via Uniswap V4 UniversalRouter
 *   4. Fetch all $GITBANK holders via Alchemy
 *   5. Distribute TEST tokens pro-rata to all $GITBANK holders
 *   6. Print receipt with all tx hashes + Basescan links
 *
 * Run: node scripts/launch-token-e2e.mjs
 */

import {
  createPublicClient, createWalletClient,
  http, fallback,
  parseAbi, parseAbiParameters, encodeAbiParameters, encodeFunctionData,
  encodePacked, decodeAbiParameters,
  formatEther,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Clanker } from "clanker-sdk";

// ── Config ──────────────────────────────────────────────────────────────────

const DEPLOYER_PK   = process.env.DEPLOYER_PRIVATE_KEY;
const RPC_MAINNET   = process.env.BASE_MAINNET_RPC_URL ?? process.env.BASE_RPC_URL;
const ALCHEMY_KEY   = RPC_MAINNET?.match(/alchemy\.com\/v2\/([^/]+)/)?.[1];
const ALCHEMY_BASE  = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
const BASE_NETWORK  = process.env.BASE_NETWORK;

if (!DEPLOYER_PK)   { console.error("DEPLOYER_PRIVATE_KEY not set"); process.exit(1); }
if (!ALCHEMY_KEY)   { console.error("No Alchemy key in BASE_MAINNET_RPC_URL / BASE_RPC_URL"); process.exit(1); }
if (BASE_NETWORK !== "mainnet") {
  console.error(`BASE_NETWORK=${BASE_NETWORK} — must be "mainnet" for this script`);
  process.exit(1);
}

// ── Addresses ───────────────────────────────────────────────────────────────

const WETH               = "0x4200000000000000000000000000000000000006";
const GITBANK_CA         = "0xC21dd0eE043930711C2a3e55F39C7d3144d09B07";
const CLANKER_V4_FACTORY = "0xe85a59c628f7d27878aceb4bf3b35733630083a9";
const UNISWAP_V4_ROUTER  = "0x6ff5693b99212da76ad316178a184ab56d299b43";
const LAUNCH_DEV_WALLET  = "0x1e660A9A1f1F08AFEF9c03c96D66260122464CF2";
const EXPLORER           = "https://basescan.org/tx";

// Token config
const TOKEN_NAME         = "TEST";
const TOKEN_SYMBOL       = "TEST";
const AUTO_BUY_ETH       = 10_000_000_000_000_000n; // 0.01 ETH
const CREATOR_BPS        = 8000;
const DEV_BPS            = 2000;
const ZERO               = "0x0000000000000000000000000000000000000000";

// ── Event topics ────────────────────────────────────────────────────────────

const TOKEN_CREATED_TOPIC0   = "0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67";
const POOL_INITIALIZE_TOPIC0 = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const INITIALIZE_DATA_PARAMS = parseAbiParameters("uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick");

// ── ABIs ────────────────────────────────────────────────────────────────────

const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes calldata commands, bytes[] calldata inputs) payable",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

let failures = 0;
const txLog = [];
function pass(m)    { console.log(`  \x1b[32m+\x1b[0m ${m}`); }
function fail(m)    { console.error(`  \x1b[31mx\x1b[0m ${m}`); failures++; }
function info(m)    { console.log(`  \x1b[33m.\x1b[0m ${m}`); }
function section(m) { console.log(`\n\x1b[1m${m}\x1b[0m`); }

function addTx(label, hash) {
  txLog.push({ label, hash });
  pass(`${label}: ${hash}`);
  info(`${EXPLORER}/${hash}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function confirm(hash) {
  return publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

// ── Alchemy helper ───────────────────────────────────────────────────────────

async function alchemyGetAssetTransfers(params) {
  const body = {
    id: 1, jsonrpc: "2.0",
    method: "alchemy_getAssetTransfers",
    params: [params],
  };
  const res = await fetch(ALCHEMY_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Alchemy error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// ── Pool decode ───────────────────────────────────────────────────────────────

function getPoolInfoFromReceipt(receipt) {
  const WORD = 64;
  const tcLog = receipt.logs.find(
    l => l.address.toLowerCase() === CLANKER_V4_FACTORY.toLowerCase()
      && l.topics[0] === TOKEN_CREATED_TOPIC0
  );
  if (!tcLog) return null;

  const poolId = `0x${tcLog.data.slice(2 + 8 * WORD, 2 + 9 * WORD)}`;

  const initLog = receipt.logs.find(l => l.topics[0] === POOL_INITIALIZE_TOPIC0);
  if (!initLog || initLog.topics.length < 4) return null;

  const [fee, tickSpacing, hooks] = decodeAbiParameters(INITIALIZE_DATA_PARAMS, initLog.data);
  const currency0 = `0x${initLog.topics[2].slice(26)}`;
  const currency1 = `0x${initLog.topics[3].slice(26)}`;
  const zeroForOne = WETH.toLowerCase() === currency0.toLowerCase();

  return { poolId, poolKey: { currency0, currency1, fee, tickSpacing, hooks }, zeroForOne };
}

// ── V4 swap calldata ──────────────────────────────────────────────────────────

function buildV4SwapData(tokenOut, amountIn, recipient, poolInfo) {
  const SWAP_EXACT_IN_SINGLE = 0x06;
  const SETTLE_ALL = 0x0f;
  const TAKE_ALL = 0x11;

  const actions = encodePacked(["uint8","uint8","uint8"], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);

  const swapParams = encodeAbiParameters(
    [{ type: "tuple", components: [
      { type: "tuple", name: "poolKey", components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ]},
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ]}],
    [{ poolKey: poolInfo.poolKey, zeroForOne: poolInfo.zeroForOne, amountIn, amountOutMinimum: 0n, hookData: "0x" }]
  );

  const settleParams = encodeAbiParameters(
    [{ name: "currency", type: "address" }, { name: "maxAmount", type: "uint256" }],
    [WETH, amountIn]
  );

  const takeParams = encodeAbiParameters(
    [{ name: "currency", type: "address" }, { name: "recipient", type: "address" }, { name: "minAmount", type: "uint256" }],
    [tokenOut, recipient, 0n]
  );

  const v4SwapInput = encodeAbiParameters(
    [{ name: "actions", type: "bytes" }, { name: "params", type: "bytes[]" }],
    [actions, [swapParams, settleParams, takeParams]]
  );

  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: ["0x10", [v4SwapInput]],
  });
}

// ── Send tx helper ────────────────────────────────────────────────────────────

async function sendTx(to, data, value = 0n) {
  const gasPrice = await publicClient.getGasPrice();
  let gas;
  try {
    const est = await publicClient.estimateGas({ account: deployer, to, data, value });
    gas = (est * 130n) / 100n;
  } catch {
    gas = 500_000n;
  }
  const hash = await walletClient.sendTransaction({ to, data, value, gas, gasPrice });
  const receipt = await confirm(hash);
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return hash;
}

// ── Viem clients ──────────────────────────────────────────────────────────────

const account = privateKeyToAccount(DEPLOYER_PK);
const deployer = account.address;

const transport = fallback([
  ...(RPC_MAINNET ? [http(RPC_MAINNET)] : []),
  http("https://mainnet.base.org"),
  http("https://base.llamarpc.com"),
]);

const publicClient = createPublicClient({ chain: base, transport });
const walletClient = createWalletClient({ account, chain: base, transport });

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n" + "=".repeat(60));
  console.log("  Gitbank Token Launch E2E — Base Mainnet");
  console.log("  " + new Date().toISOString());
  console.log("  Token: " + TOKEN_NAME + " ($" + TOKEN_SYMBOL + ")");
  console.log("  Deployer: " + deployer);
  console.log("=".repeat(60));

  // ── 0. Pre-flight checks ─────────────────────────────────────────────────
  section("0. Pre-flight");

  const [ethBal, block] = await Promise.all([
    publicClient.getBalance({ address: deployer }),
    publicClient.getBlockNumber(),
  ]);

  pass("Deployer: " + deployer + " — " + formatEther(ethBal) + " ETH");
  pass("Block: " + block.toString());
  pass("Network: Base Mainnet (chainId 8453)");
  pass("Auto-buy: " + formatEther(AUTO_BUY_ETH) + " ETH");

  if (ethBal < AUTO_BUY_ETH + 5_000_000_000_000_000n) {
    fail("Deployer ETH too low — need at least " + formatEther(AUTO_BUY_ETH + 5_000_000_000_000_000n) + " ETH");
    process.exit(1);
  }

  // ── 1. Deploy TEST token via Clanker v4 ──────────────────────────────────
  section("1. Deploy " + TOKEN_NAME + " via Clanker v4");

  const tokenConfig = {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    tokenAdmin: deployer,
    context: {
      interface: "Gitbank",
      platform: "github",
      messageId: "gitbankio/test#e2e",
      id: "11111111",
    },
    rewards: {
      recipients: [
        { recipient: deployer, admin: deployer, bps: CREATOR_BPS, token: "Both" },
        { recipient: LAUNCH_DEV_WALLET, admin: LAUNCH_DEV_WALLET, bps: DEV_BPS, token: "Both" },
      ],
    },
  };

  info("Calling Clanker SDK deploy()...");
  const clanker = new Clanker({ publicClient, wallet: walletClient });
  const { txHash: deployTxHash, waitForTransaction, error: deployError } = await clanker.deploy(tokenConfig);
  if (deployError) { fail("Clanker deploy error: " + deployError); process.exit(1); }

  addTx("Clanker v4 deploy", deployTxHash);
  info("Waiting for token deploy confirmation...");

  const { address: tokenAddress, error: waitError } = await waitForTransaction();
  if (waitError) { fail("waitForTransaction error: " + waitError); process.exit(1); }
  if (!tokenAddress) { fail("No token address returned"); process.exit(1); }

  pass("TEST token deployed: " + tokenAddress);
  info("Clanker: https://www.clanker.world/clanker/" + tokenAddress);

  // ── 2. Decode pool info from deploy receipt ──────────────────────────────
  section("2. Decode Uniswap V4 pool from receipt");

  const deployReceipt = await publicClient.getTransactionReceipt({ hash: deployTxHash });
  const poolInfo = getPoolInfoFromReceipt(deployReceipt);

  if (!poolInfo) {
    fail("Could not decode pool from receipt — logs may differ");
    info("Will attempt V4 swap without pool info (clanker.world fallback)");
  } else {
    pass("Pool ID: " + poolInfo.poolId);
    pass("currency0: " + poolInfo.poolKey.currency0);
    pass("currency1: " + poolInfo.poolKey.currency1);
    pass("fee: 0x" + poolInfo.poolKey.fee.toString(16));
    pass("tickSpacing: " + poolInfo.poolKey.tickSpacing);
    pass("hooks: " + poolInfo.poolKey.hooks);
    pass("zeroForOne: " + poolInfo.zeroForOne + " (sell WETH → buy TEST)");
  }

  if (!poolInfo) {
    fail("No pool info — cannot proceed with V4 swap");
    process.exit(1);
  }

  // ── 3. Buy TEST tokens: wrap ETH → WETH → approve → V4 swap ────────────
  section("3. Buy TEST via Uniswap V4 (0.01 ETH)");

  info("Step 3a: Wrap " + formatEther(AUTO_BUY_ETH) + " ETH → WETH");
  const wrapData = encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" });
  const wrapTx = await sendTx(WETH, wrapData, AUTO_BUY_ETH);
  addTx("ETH → WETH wrap", wrapTx);

  info("Step 3b: Approve V4 router to spend WETH");
  const approveData = encodeFunctionData({
    abi: WETH_ABI, functionName: "approve",
    args: [UNISWAP_V4_ROUTER, AUTO_BUY_ETH],
  });
  const approveTx = await sendTx(WETH, approveData);
  addTx("WETH approve V4 router", approveTx);

  info("Step 3c: V4 swap WETH → TEST via UniversalRouter");
  const swapCalldata = buildV4SwapData(tokenAddress, AUTO_BUY_ETH, deployer, poolInfo);
  const swapTx = await sendTx(UNISWAP_V4_ROUTER, swapCalldata);
  addTx("V4 swap WETH → TEST", swapTx);

  await sleep(3000);

  const tokensBought = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [deployer],
  });

  pass("TEST tokens bought: " + (Number(tokensBought) / 1e18).toFixed(4) + " TEST");
  info("(deployer balance after swap = tokens to distribute)");

  if (tokensBought === 0n) {
    fail("0 tokens bought — swap may have failed silently");
    process.exit(1);
  }

  // ── 4. Fetch $GITBANK holders ────────────────────────────────────────────
  section("4. Fetch $GITBANK holders via Alchemy");
  info("CA: " + GITBANK_CA);

  const balances = new Map();
  let pageKey;
  let page = 0;
  let totalTransfers = 0;

  do {
    const result = await alchemyGetAssetTransfers({
      contractAddresses: [GITBANK_CA],
      category: ["erc20"],
      maxCount: "0x3e8",
      withMetadata: false,
      excludeZeroValue: false,
      ...(pageKey ? { pageKey } : { fromBlock: "0x0", toBlock: "latest" }),
    });
    for (const tx of result.transfers) {
      const rawVal = tx.rawContract?.value;
      if (!rawVal) continue;
      const amount = BigInt(rawVal);
      if (amount === 0n) continue;
      const from = tx.from.toLowerCase();
      const to = (tx.to ?? "").toLowerCase();
      if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - amount);
      if (to && to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + amount);
      totalTransfers++;
    }
    pageKey = result.pageKey;
    page++;
    if (page % 10 === 0) info(`  Scanned ${totalTransfers} transfers...`);
  } while (pageKey && page < 50);

  const holders = Array.from(balances.entries())
    .filter(([addr, bal]) => bal > 0n && addr !== ZERO)
    .sort((a, b) => (b[1] > a[1] ? 1 : -1));

  const totalGitbank = holders.reduce((s, [, b]) => s + b, 0n);

  pass("Total transfers scanned: " + totalTransfers);
  pass("Unique $GITBANK holders: " + holders.length);
  pass("Total supply tracked: " + (Number(totalGitbank) / 1e18).toFixed(0) + " GITBANK");

  // ── 5. Distribute TEST tokens to all $GITBANK holders ───────────────────
  section("5. Distribute TEST to all $GITBANK holders");
  info("Total to distribute: " + (Number(tokensBought) / 1e18).toFixed(4) + " TEST");
  info("Pro-rata: each holder gets (their GITBANK / total) x tokensBought");
  info("Method: direct ERC-20 transfer from deployer wallet (NOT via vault contract)");
  info("Starting distribution to " + holders.length + " holders...\n");

  let distributed = 0;
  let skipped = 0;
  const distributionTxs = [];

  for (let i = 0; i < holders.length; i++) {
    const [addr, gitbankBal] = holders[i];
    const share = (tokensBought * gitbankBal) / totalGitbank;
    if (share === 0n) { skipped++; continue; }

    try {
      const transferData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [addr, share],
      });
      const txHash = await sendTx(tokenAddress, transferData);
      distributed++;
      distributionTxs.push({ addr, share, txHash });

      if (distributed <= 5 || distributed % 50 === 0) {
        info(`  [${distributed}/${holders.length}] ${addr} → ${(Number(share)/1e18).toFixed(4)} TEST — ${txHash}`);
      }
    } catch (err) {
      skipped++;
      info(`  [skip] ${addr}: ${err.message?.slice(0, 60)}`);
    }
  }

  pass("Distribution complete!");
  pass("Distributed to: " + distributed + " holders");
  if (skipped > 0) info("Skipped: " + skipped + " (zero share or tx failed)");

  // ── Final balances ───────────────────────────────────────────────────────
  section("Final state");

  const [finalEth, finalTestBal] = await Promise.all([
    publicClient.getBalance({ address: deployer }),
    publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [deployer] }),
  ]);

  pass("Deployer ETH remaining: " + formatEther(finalEth));
  pass("Deployer TEST remaining: " + (Number(finalTestBal) / 1e18).toFixed(4) + " (dust)");

  // ── Full receipt ─────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("  GITBANK LAUNCH RECEIPT");
  console.log("=".repeat(60));
  console.log("  Token Name  : " + TOKEN_NAME);
  console.log("  Symbol      : " + TOKEN_SYMBOL);
  console.log("  Contract    : " + tokenAddress);
  console.log("  Network     : Base Mainnet (8453)");
  console.log("  Deploy Tx   : " + deployTxHash);
  console.log("  Tokens Bought: " + (Number(tokensBought)/1e18).toFixed(4));
  console.log("  Distributed : " + distributed + " $GITBANK holders");
  console.log("  LP Rewards  : " + (CREATOR_BPS/100) + "% creator / " + (DEV_BPS/100) + "% platform");
  console.log("\n  KEY TRANSACTIONS:");
  for (const { label, hash } of txLog) {
    console.log("  [" + label.padEnd(26) + "] " + hash);
    console.log("   " + EXPLORER + "/" + hash);
  }
  if (distributionTxs.length > 0) {
    console.log("\n  FIRST 5 DISTRIBUTION TXs:");
    for (const { addr, share, txHash } of distributionTxs.slice(0, 5)) {
      console.log("  " + addr + " → " + (Number(share)/1e18).toFixed(4) + " TEST");
      console.log("  " + EXPLORER + "/" + txHash);
    }
    if (distributed > 5) console.log("  ...and " + (distributed - 5) + " more holders");
  }
  console.log("\n  Clanker : https://www.clanker.world/clanker/" + tokenAddress);
  console.log("  Basescan: https://basescan.org/token/" + tokenAddress);
  console.log("=".repeat(60));
  if (failures === 0) {
    console.log("  \x1b[32mAll steps passed — production ready\x1b[0m");
  } else {
    console.log("  \x1b[31m" + failures + " step(s) FAILED\x1b[0m");
  }
  console.log("=".repeat(60) + "\n");

  if (failures > 0) process.exit(1);
}

run().catch(err => {
  console.error("\n\x1b[31mFATAL:\x1b[0m", err.message || err);
  process.exit(1);
});
