import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  parseAbi,
  encodeFunctionData,
  encodeAbiParameters,
  decodeAbiParameters,
  parseAbiParameters,
  keccak256,
  encodePacked,
  type Hash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { randomBytes } from "crypto";
import { decryptPrivateKey } from "./key-engine";
import { logger } from "./logger";

const IS_MAINNET = process.env["BASE_NETWORK"] === "mainnet";
const CHAIN = IS_MAINNET ? base : baseSepolia;

// Primary RPC from env, with public RPCs as automatic fallback.
// viem fallback transport tries each in order, moves to next on failure.
const PRIMARY_RPC =
  process.env["BASE_RPC_URL"] ??
  (IS_MAINNET
    ? process.env["BASE_MAINNET_RPC_URL"]
    : process.env["BASE_SEPOLIA_RPC_URL"]);

const FALLBACK_RPCS = IS_MAINNET
  ? ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co"]
  : ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"];

const rpcTransports = [
  ...(PRIMARY_RPC ? [http(PRIMARY_RPC)] : []),
  ...FALLBACK_RPCS.map(url => http(url)),
];

export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: fallback(rpcTransports),
});

export const FACTORY_ADDRESS = (process.env["GIT_VAULT_FACTORY_ADDRESS"] ?? "") as Address;

// ABI fragments -- only what the Relayer needs to call
export const FACTORY_ABI = parseAbi([
  "function createGitVault(uint256 githubUserId, address ownerAddress) returns (address vault)",
  "function getVaultByGithubId(uint256 githubUserId) view returns (address)",
  "function hasVault(uint256 githubUserId) view returns (bool)",
]);

export const VAULT_ABI = parseAbi([
  // Meta-tx signatures: deployer submits, owner signs intent, relayer authorizes
  "function gitShield(address tokenAddress, uint256 amount, uint256 expectedNonce, uint256 deadline, bytes ownerSig, bytes relayerSig) external",
  "function gitUnshield(address tokenAddress, uint256 amount, address destination, uint256 expectedNonce, uint256 deadline, bytes ownerSig, bytes relayerSig) external",
  "function gitSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address dexRouter, bytes routerData, uint256 expectedNonce, uint256 deadline, bytes ownerSig, bytes relayerSig) external",
  "function initTransfer(bytes32 initHash, uint256 deadline, bytes ownerSig, bytes relayerSig) external",
  "function finalizeTransfer(address tokenAddress, address to, uint256 amount, uint256 expectedNonce, uint256 initNonce, uint256 deadline, bytes ownerSig, bytes relayerSig) external",
  "function createProject(uint256 projectId, address token, uint256 totalBudget, uint256 expectedNonce, uint256 deadline, bytes ownerSig, bytes relayerSig) external",
  "function assignTaskBounty(uint256 projectId, uint256 issueId, address contributorVault, uint256 amount, uint256 expectedNonce, uint256 deadline, bytes ownerSig, bytes relayerSig) external",
  "function executeBountyPayout(uint256 issueId, uint256 expectedNonce, uint256 deadline, bytes ownerSig, bytes relayerSig) external",
  "function reclaimBounty(uint256 issueId, uint256 expectedNonce, uint256 deadline, bytes ownerSig, bytes relayerSig) external",
  "function nonce() view returns (uint256)",
  "function owner() view returns (address)",
  "function githubUserId() view returns (uint256)",
  "function getGitTokenAddress(address tokenAddress) view returns (address)",
  "function getGitLockedBalance(address tokenAddress) view returns (uint256)",
  "function getAvailableDeposit(address tokenAddress) view returns (uint256)",
  "function getProjectAvailableBudget(uint256 projectId) view returns (uint256)",
]);

export interface TxResult {
  txHash: Hash;
  status: "pending" | "confirmed" | "failed";
  blockNumber?: bigint;
}

// ── Deployer wallet (pays all gas) ───────────────────────────────────────────

function getDeployerAccount() {
  const pk = process.env["DEPLOYER_PRIVATE_KEY"];
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  return privateKeyToAccount(pk as Hex);
}

/**
 * Submit a transaction from the deployer wallet.
 * All vault operations and vault deployments go through this path.
 * The user's execution keypair (ownerAddress) only signs intent off-chain.
 */
async function sendTxFromDeployer(
  to: Address,
  data: Hex,
  retries = 3,
  value?: bigint,
): Promise<TxResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const account = getDeployerAccount();
      const walletClient = createWalletClient({
        account,
        chain: CHAIN,
        transport: fallback(rpcTransports),
      });

      const gasEstimate = await publicClient.estimateGas({ account: account.address, to, data, ...(value ? { value } : {}) });
      const gasLimit = (gasEstimate * 120n) / 100n; // +20% buffer

      const gasPrice = await publicClient.getGasPrice();
      const bumpedGasPrice = (gasPrice * BigInt(100 + attempt * 15)) / 100n;

      const txHash = await walletClient.sendTransaction({ to, data, gas: gasLimit, gasPrice: bumpedGasPrice, ...(value ? { value } : {}) });

      logger.info({ txHash, attempt }, "Transaction submitted from deployer");
      return { txHash, status: "pending" };
    } catch (err) {
      lastError = err;
      logger.warn({ err, attempt }, "Deployer transaction attempt failed");
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

// ── Owner signing (intent only, no gas) ──────────────────────────────────────

/**
 * Sign a hash with the owner's encrypted execution keypair.
 * The owner never submits transactions -- only signs intent.
 */
async function generateOwnerSig(encryptedPk: string, hash: Hex): Promise<Hex> {
  const pk = decryptPrivateKey(encryptedPk);
  const signer = privateKeyToAccount(pk as Hex);
  return signer.signMessage({ message: { raw: hash } });
}

// ── Relayer signing ──────────────────────────────────────────────────────────

/**
 * Generate a short-lived ECDSA authorization signature for a vault operation.
 * Hash: keccak256(abi.encodePacked(vaultAddress, githubUserId, deadline))
 * Mirrors the requireRelayerAuth modifier in GitVault.sol.
 */
async function generateRelayerSig(
  vaultAddress: Address,
  githubUserId: bigint,
  deadline: bigint,
): Promise<Hex> {
  const key = process.env["RELAYER_SIGNING_KEY"];
  if (!key) throw new Error("RELAYER_SIGNING_KEY is not set");
  const signer = privateKeyToAccount(key as Hex);
  const hash = keccak256(encodePacked(
    ["address", "uint256", "uint256"],
    [vaultAddress, githubUserId, deadline],
  ));
  return signer.signMessage({ message: { raw: hash } });
}

/**
 * Call a vault function via the deployer wallet.
 * Owner signs intent (ownerSig), relayer authorizes (relayerSig), deployer pays gas.
 *
 * ownerSig hash rules (mirrors GitVault.sol modifiers):
 *   - gitUnshield: keccak256(vault, githubUserId, destination, nonce, deadline) -- destination bound!
 *   - initTransfer: keccak256(vault, githubUserId, initHash, deadline)
 *   - all others: keccak256(vault, githubUserId, nonce, deadline)
 *
 * args layout (before appending deadline, ownerSig, relayerSig):
 *   gitShield:        [token, amount, nonce]
 *   gitUnshield:      [token, amount, destination, nonce]
 *   gitSwap:          [tokenIn, tokenOut, amountIn, minOut, router, routerData, nonce]
 *   initTransfer:     [initHash]
 *   finalizeTransfer: [token, to, amount, nonce, initNonce]
 *   createProject:    [projectId, token, budget, nonce]
 *   assignTaskBounty: [projectId, issueId, contributorVault, amount, nonce]
 *   executeBountyPayout: [issueId, nonce]
 *   reclaimBounty:    [issueId, nonce]
 */
export async function callVault(
  encryptedPk: string,
  vaultAddress: Address,
  githubUserId: bigint,
  functionName: string,
  args: readonly unknown[],
): Promise<TxResult> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5-minute window

  // Build ownerSig hash based on function type
  let ownerSigHash: Hex;

  if (functionName === "initTransfer") {
    // ownerSig covers initHash (args[0]) instead of nonce
    const initHash = args[0] as Hex;
    ownerSigHash = keccak256(encodePacked(
      ["address", "uint256", "bytes32", "uint256"],
      [vaultAddress, githubUserId, initHash, deadline],
    ));
  } else if (functionName === "gitUnshield") {
    // destination (args[2]) is bound in hash to prevent fund redirection
    const destination = args[2] as Address;
    const nonce = args[3] as bigint;
    ownerSigHash = keccak256(encodePacked(
      ["address", "uint256", "address", "uint256", "uint256"],
      [vaultAddress, githubUserId, destination, nonce, deadline],
    ));
  } else {
    // Generic nonce-based: nonce is the last arg
    const nonce = args[args.length - 1] as bigint;
    ownerSigHash = keccak256(encodePacked(
      ["address", "uint256", "uint256", "uint256"],
      [vaultAddress, githubUserId, nonce, deadline],
    ));
  }

  const [ownerSig, relayerSig] = await Promise.all([
    generateOwnerSig(encryptedPk, ownerSigHash),
    generateRelayerSig(vaultAddress, githubUserId, deadline),
  ]);

  const data = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: functionName as never,
    args: [...args, deadline, ownerSig, relayerSig] as never,
  });

  return sendTxFromDeployer(vaultAddress, data);
}

/**
 * Build signed calldata for a vault function WITHOUT submitting.
 * Returns the ABI-encoded calldata and deadline so callers can pass it
 * to Base MCP send_calls (user pays gas) instead of the deployer.
 *
 * Same signature logic as callVault -- see that function for hash rules.
 */
export async function prepareVaultCalldata(
  encryptedPk: string,
  vaultAddress: Address,
  githubUserId: bigint,
  functionName: string,
  args: readonly unknown[],
  deadlineSeconds = 600,
): Promise<{ data: Hex; deadline: bigint }> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

  let ownerSigHash: Hex;
  if (functionName === "gitUnshield") {
    const destination = args[2] as Address;
    const nonce = args[3] as bigint;
    ownerSigHash = keccak256(encodePacked(
      ["address", "uint256", "address", "uint256", "uint256"],
      [vaultAddress, githubUserId, destination, nonce, deadline],
    ));
  } else {
    const nonce = args[args.length - 1] as bigint;
    ownerSigHash = keccak256(encodePacked(
      ["address", "uint256", "uint256", "uint256"],
      [vaultAddress, githubUserId, nonce, deadline],
    ));
  }

  const [ownerSig, relayerSig] = await Promise.all([
    generateOwnerSig(encryptedPk, ownerSigHash),
    generateRelayerSig(vaultAddress, githubUserId, deadline),
  ]);

  const data = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: functionName as never,
    args: [...args, deadline, ownerSig, relayerSig] as never,
  });

  return { data, deadline };
}

/**
 * Deploy a new GitVault clone for the given GitHub user ID.
 * Deployer pays gas; ownerAddress is passed explicitly (meta-tx model).
 */
export async function deployVault(
  encryptedPk: string,
  githubUserId: bigint,
  ownerAddress: Address,
): Promise<TxResult> {
  const data = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "createGitVault",
    args: [githubUserId, ownerAddress],
  });
  // encryptedPk unused here (deployer pays), but kept in signature for API consistency
  void encryptedPk;
  return sendTxFromDeployer(FACTORY_ADDRESS, data);
}

/**
 * Lock ERC-20 tokens that have been sent to the vault address.
 * No approve needed -- gitShield uses balance-based detection.
 */
export async function lockDeposit(
  encryptedPk: string,
  vaultAddress: Address,
  githubUserId: bigint,
  tokenAddress: Address,
  amount: bigint,
  nonce: bigint,
): Promise<TxResult> {
  return callVault(encryptedPk, vaultAddress, githubUserId, "gitShield", [tokenAddress, amount, nonce]);
}

// ── ERC-20 helpers ────────────────────────────────────────────────────────────

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export async function readErc20Balance(tokenAddress: Address, account: Address): Promise<bigint> {
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [account],
  }) as Promise<bigint>;
}

export async function readVaultNonce(vaultAddress: Address): Promise<bigint> {
  return publicClient.readContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "nonce",
  }) as Promise<bigint>;
}

export async function readVaultBalance(
  vaultAddress: Address,
  tokenAddress: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "getGitLockedBalance",
    args: [tokenAddress],
  }) as Promise<bigint>;
}

/**
 * Available amount of ERC-20 tokens sitting in the vault waiting to be shielded.
 * Equals vault.balanceOf(token) minus already-locked collateral.
 */
export async function readVaultAvailableDeposit(
  vaultAddress: Address,
  tokenAddress: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "getAvailableDeposit",
    args: [tokenAddress],
  }) as Promise<bigint>;
}

export async function getVaultByGithubId(githubUserId: bigint): Promise<Address> {
  return publicClient.readContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "getVaultByGithubId",
    args: [githubUserId],
  }) as Promise<Address>;
}

// ── DEX helpers ───────────────────────────────────────────────────────────────

const UNISWAP_V3_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)",
]);

/**
 * Build ABI-encoded calldata for a Uniswap v3 exactInputSingle swap.
 * The recipient is the vault itself so swapped tokens land back in the vault.
 */
export function buildUniswapV3SwapData(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  recipient: Address,
  feeTier: number = 500,
): `0x${string}` {
  return encodeFunctionData({
    abi: UNISWAP_V3_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn,
        tokenOut,
        fee: feeTier,
        recipient,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

/** Convert human-readable token amount to on-chain units (wei). */
export function toTokenUnits(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 10 ** decimals));
}

/**
 * Mirror GitVault._collectFee for FEE_SWAP_BPS = 30 (0.30%).
 * The vault approves the DEX router for exactly this net amount,
 * so routerData must use the same value as amountIn.
 *
 * MINIMUM_FEE = 1e5 (0.1 USDC in 6-decimal units).
 */
export function computeSwapNetAmount(grossAmount: bigint): bigint {
  const FEE_SWAP_BPS = 30n;
  const BPS_DENOMINATOR = 10_000n;
  const MINIMUM_FEE = 100_000n; // 1e5 — matches GitVault constant
  let fee = (grossAmount * FEE_SWAP_BPS) / BPS_DENOMINATOR;
  if (fee < MINIMUM_FEE) fee = MINIMUM_FEE;
  return grossAmount - fee;
}

/**
 * Compute gross gitUnshield amount needed so that the NET amount received by the
 * destination equals `netRequired`.
 *
 * GitVault._collectFee (FEE_LOCK_UNLOCK_BPS = 10, 0.10%):
 *   fee  = max(gross * 10 / 10000, MINIMUM_FEE)  where MINIMUM_FEE = 100_000 (0.1 USDC)
 *   net  = gross - fee
 *
 * For amounts below 100 USDC the minimum fee always applies, so gross = net + MINIMUM_FEE.
 * For larger amounts we solve gross = ceil(net * 10000 / 9990).
 */
export function computeUnshieldGrossForNet(netRequired: bigint): bigint {
  const FEE_LOCK_UNLOCK_BPS = 10n;
  const BPS_DENOMINATOR     = 10_000n;
  const MINIMUM_FEE         = 100_000n;

  // Determine which branch the contract will take.
  // If minimum fee applies: gross = net + MINIMUM_FEE (fee = MINIMUM_FEE).
  // Verify: fee_from_bps = (net + MINIMUM_FEE) * 10 / 10000 < MINIMUM_FEE when net < 100 USDC.
  const grossWithMinFee = netRequired + MINIMUM_FEE;
  const feeFromBps      = (grossWithMinFee * FEE_LOCK_UNLOCK_BPS) / BPS_DENOMINATOR;
  if (feeFromBps < MINIMUM_FEE) {
    return grossWithMinFee; // minimum fee branch
  }
  // BPS branch: gross = ceil(net * 10000 / (10000 - BPS))
  const denominator = BPS_DENOMINATOR - FEE_LOCK_UNLOCK_BPS; // 9990
  return (netRequired * BPS_DENOMINATOR + denominator - 1n) / denominator;
}

// ── Uniswap v4 + Clanker helpers ──────────────────────────────────────────────

const UNISWAP_V4_ROUTER = (
  process.env["UNISWAP_V4_ROUTER_ADDRESS"] ?? "0x6ff5693b99212da76ad316178a184ab56d299b43"
) as Address;

// Permit2 is the canonical token approval contract used by Uniswap V4
// UniversalRouter. Direct ERC-20 approval to the router does NOT work —
// the router calls permit2TransferFrom internally.
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

const PERMIT2_ABI = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

const UNISWAP_V4_STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71" as Address;

const STATE_VIEW_ABI = parseAbi([
  "function getPoolKey(bytes32 id) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
]);

const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs) external payable",
]);

const BASE_TOKENS = new Set([
  "0x4200000000000000000000000000000000000006", // WETH (Base mainnet + Sepolia)
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC (Base mainnet)
]);

export interface ClankerPoolInfo {
  poolId: `0x${string}`;
  poolKey: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  };
  zeroForOne: boolean;
}

export async function fetchClankerPoolInfo(
  tokenIn: Address,
  tokenOut: Address,
): Promise<ClankerPoolInfo | null> {
  if (!IS_MAINNET) return null;

  const clankerToken = BASE_TOKENS.has(tokenIn.toLowerCase())
    ? tokenOut
    : BASE_TOKENS.has(tokenOut.toLowerCase())
      ? tokenIn
      : null;

  if (!clankerToken) return null;

  try {
    const resp = await fetch(
      `https://www.clanker.world/api/tokens/${clankerToken.toLowerCase()}`,
      {
        headers: { "User-Agent": "Gitbank/1.0" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      type?: string;
      pool_address?: string;
    };

    if (data.type !== "clanker_v4" || !data.pool_address) return null;

    const poolId = data.pool_address as `0x${string}`;

    const raw = await publicClient.readContract({
      address: UNISWAP_V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: "getPoolKey",
      args: [poolId],
    }) as [Address, Address, number, number, Address];

    const [currency0, currency1, fee, tickSpacing, hooks] = raw;
    const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();

    return {
      poolId,
      poolKey: { currency0, currency1, fee, tickSpacing, hooks },
      zeroForOne,
    };
  } catch (err) {
    logger.warn({ err, tokenIn, tokenOut }, "fetchClankerPoolInfo failed -- falling back to v3");
    return null;
  }
}

// Clanker v4 factory address (Base mainnet).
const CLANKER_V4_FACTORY = "0xe85a59c628f7d27878aceb4bf3b35733630083a9";

// topic0 of the Clanker v4 `TokenCreated` event.
// keccak256("TokenCreated(address,address,address,string,string,string,string,string,int24,address,bytes32,address,address,address,uint256,address[])")
// Verified: matches on-chain receipts for Clanker v4 deploys.
const TOKEN_CREATED_TOPIC0 = "0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67";

// topic0 of the Uniswap V4 PoolManager `Initialize` event.
// keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
// Verified: emitted in the same deploy receipt, carries fee + tickSpacing + hooks.
const POOL_INITIALIZE_TOPIC0 = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

// Non-indexed data layout of the Initialize event: fee, tickSpacing, hooks, sqrtPriceX96, tick
const INITIALIZE_DATA_PARAMS = parseAbiParameters(
  "uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick",
);

/**
 * Resolve Uniswap V4 pool info for a Clanker token by parsing the deploy
 * transaction receipt — zero additional on-chain reads required.
 *
 * Two events from the same receipt give us everything:
 *  1. Clanker `TokenCreated` (factory address, token_created_topic0):
 *     - word[8] of non-indexed data = poolId (bytes32)
 *  2. Uniswap V4 PoolManager `Initialize` (pool_initialize_topic0):
 *     - non-indexed data = (fee, tickSpacing, hooks, sqrtPriceX96, tick)
 *     - topic2 = currency0 (indexed), topic3 = currency1 (indexed)
 *
 * Note: Clanker v4 uses dynamic fees (fee = 0x800000 in PoolKey).
 */
export async function getPoolInfoFromDeployReceipt(
  deployTxHash: `0x${string}`,
  tokenIn: Address,
): Promise<ClankerPoolInfo | null> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: deployTxHash });

    // 1. Find TokenCreated → extract poolId from word[8] of non-indexed data.
    const tokenCreatedLog = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === CLANKER_V4_FACTORY &&
        l.topics[0] === TOKEN_CREATED_TOPIC0,
    );
    if (!tokenCreatedLog) {
      logger.warn({ deployTxHash }, "getPoolInfoFromDeployReceipt: no TokenCreated event in receipt");
      return null;
    }
    const WORD = 64; // hex chars per 32-byte word
    const poolId = `0x${tokenCreatedLog.data.slice(2 + 8 * WORD, 2 + 9 * WORD)}` as `0x${string}`;

    // 2. Find PoolManager Initialize → extract fee, tickSpacing, hooks, currency0, currency1.
    const initLog = receipt.logs.find((l) => l.topics[0] === POOL_INITIALIZE_TOPIC0);
    if (!initLog || initLog.topics.length < 4) {
      logger.warn({ deployTxHash }, "getPoolInfoFromDeployReceipt: no Initialize event in receipt");
      return null;
    }

    const [fee, tickSpacing, hooks] = decodeAbiParameters(
      INITIALIZE_DATA_PARAMS,
      initLog.data,
    );
    // currency0 / currency1 are indexed (topics[2] / topics[3]) — strip 12-byte padding.
    const currency0 = `0x${initLog.topics[2]!.slice(26)}` as Address;
    const currency1 = `0x${initLog.topics[3]!.slice(26)}` as Address;

    const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();

    logger.info(
      { deployTxHash, poolId, currency0, currency1, fee, tickSpacing, zeroForOne },
      "getPoolInfoFromDeployReceipt: pool info resolved",
    );

    return {
      poolId,
      poolKey: { currency0, currency1, fee, tickSpacing, hooks },
      zeroForOne,
    };
  } catch (err) {
    logger.warn({ err, deployTxHash }, "getPoolInfoFromDeployReceipt failed");
    return null;
  }
}

export function buildUniswapV4SwapData(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  recipient: Address,
  poolInfo: ClankerPoolInfo,
): `0x${string}` {
  const SWAP_EXACT_IN_SINGLE = 0x06;
  const SETTLE_ALL = 0x0c; // V4 Actions.sol: SETTLE_ALL = 0x0c
  const TAKE_ALL = 0x0f;   // V4 Actions.sol: TAKE_ALL = 0x0f

  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL],
  );

  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            type: "tuple",
            name: "poolKey",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        poolKey: poolInfo.poolKey,
        zeroForOne: poolInfo.zeroForOne,
        amountIn,
        amountOutMinimum: 0n,
        hookData: "0x",
      },
    ],
  );

  const settleParams = encodeAbiParameters(
    [{ name: "currency", type: "address" }, { name: "maxAmount", type: "uint256" }],
    [tokenIn, amountIn],
  );

  // TAKE_ALL sends all output tokens to msg.sender (the UniversalRouter caller).
  // It takes only (currency, minAmount) — NO recipient param.
  // Passing a recipient address as the 2nd param causes the router to decode it
  // as minAmount (a huge uint256), which exceeds any real balance and reverts.
  const takeParams = encodeAbiParameters(
    [
      { name: "currency", type: "address" },
      { name: "minAmount", type: "uint256" },
    ],
    [tokenOut, 0n],
  );

  const v4SwapInput = encodeAbiParameters(
    [{ name: "actions", type: "bytes" }, { name: "params", type: "bytes[]" }],
    [actions, [swapParams, settleParams, takeParams]],
  );

  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: ["0x10", [v4SwapInput]],
  });
}

export async function buildSwapRouterData(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  recipient: Address,
  poolInfo?: ClankerPoolInfo,
): Promise<{ routerAddress: Address; routerData: `0x${string}` }> {
  // Use caller-supplied pool info first (e.g. from deploy receipt), then try
  // the clanker.world REST API as a fallback, then fall back to Uniswap v3.
  const clankerInfo = poolInfo ?? await fetchClankerPoolInfo(tokenIn, tokenOut);

  if (clankerInfo) {
    return {
      routerAddress: UNISWAP_V4_ROUTER,
      routerData: buildUniswapV4SwapData(tokenIn, tokenOut, amountIn, recipient, clankerInfo),
    };
  }

  const v3Router = (process.env["DEX_ROUTER_ADDRESS"] ?? "") as Address;
  return {
    routerAddress: v3Router,
    routerData: buildUniswapV3SwapData(tokenIn, tokenOut, amountIn, recipient),
  };
}

// ── x402 payment helpers ──────────────────────────────────────────────────────

export interface X402PaymentOption {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  /** Full resource field from the top-level 402 body (string URL or object). */
  resource: unknown;
  description?: string;
  mimeType?: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: { name?: string; version?: string };
  /** HTTP method to use when retrying the request with X-PAYMENT header. */
  probeMethod: "GET" | "POST";
  /** Body to include on POST retry (from extensions.bazaar.info.input.body). */
  retryBody?: unknown;
}

// USDC contract address on Base mainnet + Sepolia (both lowercase for comparison)
const USDC_ADDRESSES = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base mainnet
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // Base Sepolia
]);

/** Attempt a single probe; returns the Response or null if not reached. */
async function probeOnce(url: string, method: "GET" | "POST"): Promise<Response | null> {
  try {
    return await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
}

/**
 * Probe a URL for x402 payment requirements.
 * Tries GET first; if it does not return 402 (e.g. POST-only endpoints like Exa),
 * retries with POST. Normalises the `amount` alias used by some providers (Exa)
 * to the standard `maxAmountRequired` field.
 *
 * Returns null if neither probe returns 402 with a parseable PAYMENT-REQUIRED header.
 * Throws if the URL is completely unreachable.
 */
export async function fetchX402Requirements(url: string): Promise<X402PaymentOption | null> {
  // Try GET, then POST as fallback.
  let res: Response | null = null;
  let probeMethod: "GET" | "POST" = "GET";

  try {
    // Probe GET and POST in parallel.
    // Some endpoints (e.g. Nansen) return 402 for both GET and POST probes but
    // only accept POST for the actual data request. The bazaar.method field in
    // the POST probe's PAYMENT-REQUIRED header is the authoritative signal.
    // We therefore prefer the POST probe when both return 402 and the POST
    // bazaar.method is "POST".
    const [getRes, postRes] = await Promise.all([
      fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) }).catch(() => null),
      probeOnce(url, "POST"),
    ]);

    const getIs402  = getRes?.status === 402;
    const postIs402 = postRes?.status === 402;

    if (getIs402 && postIs402) {
      // Both return 402 — inspect the POST probe's bazaar.method to decide.
      const postRaw = postRes!.headers.get("PAYMENT-REQUIRED") ?? postRes!.headers.get("X-PAYMENT-REQUIRED");
      let postBazaarMethod: string | undefined;
      if (postRaw) {
        try {
          const postDecoded = JSON.parse(Buffer.from(postRaw, "base64").toString("utf-8")) as {
            extensions?: { bazaar?: { info?: { input?: { method?: string } } } };
          };
          postBazaarMethod = postDecoded?.extensions?.bazaar?.info?.input?.method;
        } catch { /* ignore */ }
      }
      // Prefer POST probe when it explicitly says the retry method is POST.
      if (postBazaarMethod === "POST") {
        res = postRes!;
        probeMethod = "POST";
      } else {
        res = getRes!;
        probeMethod = "GET";
      }
    } else if (postIs402) {
      res = postRes!;
      probeMethod = "POST";
    } else if (getIs402) {
      res = getRes!;
      probeMethod = "GET";
    }
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res || res.status !== 402) return null;

  // x402 V2 uses PAYMENT-REQUIRED header; V1 used X-PAYMENT-REQUIRED
  const raw = res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("X-PAYMENT-REQUIRED");
  if (!raw) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  } catch {
    return null;
  }

  // V2 shape: { accepts: [...] }  |  V1 shape: the option object itself
  const accepts = (decoded as { accepts?: unknown[] }).accepts;
  const rawCandidates: unknown[] = Array.isArray(accepts) && accepts.length > 0
    ? accepts
    : [decoded];

  // Normalise candidates: some providers use `amount` instead of `maxAmountRequired` (Exa v2).
  // Also extract retry method + body from bazaar extensions when present.
  const extensions = (decoded as { extensions?: { bazaar?: { info?: { input?: { method?: string; body?: unknown } } } } }).extensions;
  const bazaarMethod = extensions?.bazaar?.info?.input?.method;
  const rawBazaarBody = extensions?.bazaar?.info?.input?.body;
  // Clean bazaar body: remove deprecated fields that conflict with preferred ones.
  // Nansen's bazaar example includes both `timeframe` and `date` but rejects both together.
  // `date` is explicitly deprecated in their schema — strip it when `timeframe` is present.
  let bazaarBody = rawBazaarBody;
  if (bazaarBody && typeof bazaarBody === "object" && !Array.isArray(bazaarBody)) {
    const b = bazaarBody as Record<string, unknown>;
    if (b["timeframe"] !== undefined && b["date"] !== undefined) {
      const { date: _removed, ...cleaned } = b;
      void _removed;
      bazaarBody = cleaned;
    }
  }
  const retryMethod: "GET" | "POST" = bazaarMethod === "POST" ? "POST" : probeMethod;

  // x402 v2: resource is at top-level of decoded body (not inside each accepts item)
  const topLevelResource = (decoded as { resource?: unknown }).resource;

  const candidates: X402PaymentOption[] = rawCandidates.map((c) => {
    const raw = c as Record<string, unknown>;
    return {
      ...raw,
      // Normalise amount aliases → maxAmountRequired
      maxAmountRequired: String(raw["maxAmountRequired"] ?? raw["amount"] ?? "0"),
      // Propagate top-level resource to each candidate (v2: { url, description, mimeType } or string)
      resource: raw["resource"] ?? topLevelResource,
      probeMethod: retryMethod,
      retryBody:   bazaarBody ?? undefined,
    } as X402PaymentOption;
  });

  // Prefer Base mainnet (eip155:8453) + USDC
  const baseUSDC = candidates.find((c) =>
    c.network?.includes("8453") &&
    USDC_ADDRESSES.has((c.asset ?? "").toLowerCase()),
  );
  const anyBase = candidates.find((c) => c.network?.includes("8453"));

  return baseUSDC ?? anyBase ?? candidates[0] ?? null;
}

/**
 * Convert x402 atomic amount string to human-readable USDC amount.
 * USDC has 6 decimals.
 */
export function x402AtomicToHuman(atomic: string, decimals = 6): number {
  return Number(atomic) / 10 ** decimals;
}

// ── x402 EIP-3009 signing + request helpers ──────────────────────────────────

/** Return the deployer EOA address (used as intermediate payer for x402 flows). */
export function getDeployerAddress(): Address {
  return getDeployerAccount().address;
}

/**
 * Wait for a transaction to be included in a block.
 * Throws if the tx reverts or is not found within timeoutMs.
 */
export async function waitForTxConfirmation(
  txHash: Hash,
  timeoutMs = 60_000,
): Promise<void> {
  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs });
}

export interface X402PaymentPayload {
  x402Version: number;
  /** x402 v2: resource field from the 402 body (string URL or { url, description, mimeType }) */
  resource?: unknown;
  /** x402 v2: full accepted payment requirements (from the 402 response) */
  accepted?: {
    scheme: string;
    network: string;
    asset: string;
    payTo: string;
    amount: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown>;
  };
  /** x402 v1 compat: top-level scheme */
  scheme?: string;
  /** x402 v1 compat: top-level network */
  network?: string;
  payload: {
    signature: Hex;
    authorization: {
      from: Address;
      to: Address;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: Hex;
    };
  };
}

/**
 * Sign an EIP-3009 TransferWithAuthorization using the deployer private key.
 * The deployer must already hold `amount` of the token before this signature
 * is submitted to the x402 facilitator (unshield to deployer first).
 */
export async function signEip3009Authorization(
  paymentOpt: X402PaymentOption,
  amount: bigint,
): Promise<X402PaymentPayload> {
  const account = getDeployerAccount();
  const walletClient = createWalletClient({
    account,
    chain: CHAIN,
    transport: fallback(rpcTransports),
  });

  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  // x402 spec: validAfter = 10 min before now (not 0); validBefore = now + timeout
  const validAfter = BigInt(Math.floor(Date.now() / 1000) - 600);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);

  const usdcAddress = paymentOpt.asset as Address;
  const domainName = paymentOpt.extra?.name ?? "USD Coin";
  const domainVersion = paymentOpt.extra?.version ?? "2";

  const signature = await walletClient.signTypedData({
    domain: {
      name: domainName,
      version: domainVersion,
      chainId: CHAIN.id,
      verifyingContract: usdcAddress,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: paymentOpt.payTo,
      value: amount,
      validAfter,
      validBefore,
      nonce,
    },
  });

  // x402 v2 payload format: resource + accepted at top level, no scheme/network
  return {
    x402Version: 2,
    resource: paymentOpt.resource,
    accepted: {
      scheme: paymentOpt.scheme ?? "exact",
      network: paymentOpt.network,
      asset: paymentOpt.asset,
      payTo: paymentOpt.payTo,
      amount: amount.toString(),
      maxTimeoutSeconds: paymentOpt.maxTimeoutSeconds,
      extra: paymentOpt.extra as Record<string, unknown> | undefined,
    },
    payload: {
      authorization: {
        from: account.address,
        to: paymentOpt.payTo,
        value: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
      signature,
    },
  };
}

export interface X402ApiResponse {
  status: number;
  body: string;
  paymentResponse?: string;
}

/**
 * Send an HTTP request with the X-PAYMENT header to a paid x402 endpoint.
 * Uses GET by default (matches the initial 402 probe method).
 */
export async function sendX402Request(
  url: string,
  paymentPayload: X402PaymentPayload,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<X402ApiResponse> {
  const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  // x402 v2 uses PAYMENT-SIGNATURE; v1 used X-PAYMENT
  const paymentHeaderName =
    paymentPayload.x402Version === 2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT";

  const headers: Record<string, string> = {
    [paymentHeaderName]: encoded,
    "Content-Type": "application/json",
  };

  const opts: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(20_000),
    ...(body !== undefined && method === "POST" ? { body: JSON.stringify(body) } : {}),
  };

  const res = await fetch(url, opts);
  const text = await res.text();
  const paymentResponse = res.headers.get("PAYMENT-RESPONSE") ?? undefined;

  return { status: res.status, body: text, paymentResponse };
}

// ── Direct ERC-20 transfer from deployer ─────────────────────────────────────

const ERC20_TRANSFER_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

// ── GitbankAirdrop contract ───────────────────────────────────────────────────
// Batch push-airdrop: deployer approves the contract, then calls batchTransfer()
// in chunks of up to 400 addresses per tx.

const GITBANK_AIRDROP_ADDRESS = "0xAa29D8644EB53796eE123b09e3D9177CC99C480f" as Address;
const BATCH_SIZE = 400;

const AIRDROP_ABI = parseAbi([
  "function batchTransfer(address token, address[] calldata recipients, uint256[] calldata amounts) external",
]);

const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/**
 * Distribute tokens from the deployer wallet to a list of recipients using
 * the GitbankAirdrop contract. Cheaper and more reliable than 1 tx per holder.
 *
 * Steps:
 *   1. deployer.approve(airdropContract, totalAmount)
 *   2. loop: airdropContract.batchTransfer(token, recipients[], amounts[]) in chunks of BATCH_SIZE
 *
 * Returns total number of recipients that received tokens.
 */
export async function batchAirdropFromDeployer(
  tokenAddress: Address,
  recipients: Address[],
  amounts: bigint[],
): Promise<{ count: number; txHashes: string[] }> {
  if (recipients.length === 0) return { count: 0, txHashes: [] };
  if (recipients.length !== amounts.length) throw new Error("recipients/amounts length mismatch");

  const totalAmount = amounts.reduce((s, a) => s + a, 0n);
  const txHashes: string[] = [];

  // 1. Approve airdrop contract to pull totalAmount from deployer
  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [GITBANK_AIRDROP_ADDRESS, totalAmount],
  });
  const approveTx = await sendTxFromDeployer(tokenAddress, approveData);
  txHashes.push(approveTx.txHash);

  // 2. Batch transfer in chunks
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batchRecipients = recipients.slice(i, i + BATCH_SIZE);
    const batchAmounts = amounts.slice(i, i + BATCH_SIZE);
    const batchData = encodeFunctionData({
      abi: AIRDROP_ABI,
      functionName: "batchTransfer",
      args: [tokenAddress, batchRecipients, batchAmounts],
    });
    const batchTx = await sendTxFromDeployer(GITBANK_AIRDROP_ADDRESS, batchData);
    txHashes.push(batchTx.txHash);
    logger.info(
      { batch: Math.floor(i / BATCH_SIZE) + 1, count: batchRecipients.length, tx: batchTx.txHash },
      "batchAirdropFromDeployer: batch sent",
    );
  }

  return { count: recipients.length, txHashes };
}

/**
 * Send ERC-20 tokens directly from the deployer wallet to a recipient.
 * Used for contest prize payments.
 */
export async function sendErc20FromDeployer(
  tokenAddress: Address,
  to: Address,
  amount: bigint,
): Promise<TxResult> {
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [to, amount],
  });
  return sendTxFromDeployer(tokenAddress, data);
}

// ── MCP launchpad: buy new token with creator ETH deposit ────────────────────

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as Address;

const WETH_DEPOSIT_ABI = parseAbi([
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/**
 * Buy a newly launched token from the deployer wallet using ETH from the MCP
 * creator buy-in deposit. Steps:
 *   1. Wrap ETH → WETH
 *   2. Approve Uniswap router for WETH
 *   3. Swap WETH → new token (v4 for Clanker tokens, v3 fallback)
 *   4. Return total tokens bought (deployer wallet balance of new token)
 *
 * @param poolInfo  Optional: pass pool info resolved from the deploy tx receipt
 *                  to skip the clanker.world API call (which is unreliable for
 *                  newly deployed tokens). Use getPoolInfoFromDeployReceipt().
 */
export async function buyTokenWithEthFromDeployer(
  newTokenAddress: Address,
  ethAmountWei: bigint,
  poolInfo?: ClankerPoolInfo,
): Promise<{ tokensBought: bigint; buyTxHash: string }> {
  const deployerAddress = getDeployerAddress();

  // 1. Wrap ETH → WETH
  const wrapData = encodeFunctionData({ abi: WETH_DEPOSIT_ABI, functionName: "deposit" });
  await sendTxFromDeployer(WETH_ADDRESS, wrapData, 3, ethAmountWei);

  // 2. Determine router + calldata (use caller-supplied poolInfo to avoid
  //    clanker.world API call, which returns empty for freshly deployed tokens)
  const { routerAddress, routerData } = await buildSwapRouterData(
    WETH_ADDRESS,
    newTokenAddress,
    ethAmountWei,
    deployerAddress,
    poolInfo,
  );

  // 3. Approve WETH for Permit2 (required by Uniswap V4 UniversalRouter) or
  //    direct ERC-20 approval for V3 SwapRouter02.
  //    V4 router calls permit2TransferFrom internally — direct ERC-20 approval
  //    to the router has no effect and the swap will revert.
  const isV4 = routerAddress.toLowerCase() === UNISWAP_V4_ROUTER.toLowerCase();
  if (isV4) {
    // 3a. ERC-20 approve Permit2 to pull WETH from deployer
    const approvePermit2Data = encodeFunctionData({
      abi: WETH_DEPOSIT_ABI,
      functionName: "approve",
      args: [PERMIT2_ADDRESS, ethAmountWei],
    });
    await sendTxFromDeployer(WETH_ADDRESS, approvePermit2Data);

    // 3b. Permit2.approve — grant V4 router allowance via Permit2
    //     amount: uint160 (bigint), expiration: uint48 (number, unix seconds)
    const expiration = Math.floor(Date.now() / 1000) + 1800; // 30 min from now
    const permit2ApproveData = encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: "approve",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: [WETH_ADDRESS, UNISWAP_V4_ROUTER, ethAmountWei as any, expiration],
    });
    await sendTxFromDeployer(PERMIT2_ADDRESS, permit2ApproveData);
  } else {
    // V3 SwapRouter02 uses direct ERC-20 approval
    const approveData = encodeFunctionData({
      abi: WETH_DEPOSIT_ABI,
      functionName: "approve",
      args: [routerAddress, ethAmountWei],
    });
    await sendTxFromDeployer(WETH_ADDRESS, approveData);
  }

  // 4. Execute swap
  const swapResult = await sendTxFromDeployer(routerAddress, routerData);
  await waitForTxConfirmation(swapResult.txHash as `0x${string}`, 90_000);

  // 5. Read token balance (new token, so deployer had 0 before swap)
  const tokensBought = await publicClient.readContract({
    address: newTokenAddress,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [deployerAddress],
  }) as bigint;

  return { tokensBought, buyTxHash: swapResult.txHash };
}
