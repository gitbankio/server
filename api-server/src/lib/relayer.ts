import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  encodeAbiParameters,
  keccak256,
  encodePacked,
  type Hash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { decryptPrivateKey } from "./key-engine";
import { logger } from "./logger";

const CHAIN = process.env["BASE_NETWORK"] === "mainnet" ? base : baseSepolia;
const RPC_URL =
  process.env["BASE_RPC_URL"] ??
  (process.env["BASE_NETWORK"] === "mainnet"
    ? process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org"
    : process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org");

export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
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
): Promise<TxResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const account = getDeployerAccount();
      const walletClient = createWalletClient({
        account,
        chain: CHAIN,
        transport: http(RPC_URL),
      });

      const gasEstimate = await publicClient.estimateGas({ account: account.address, to, data });
      const gasLimit = (gasEstimate * 120n) / 100n; // +20% buffer

      const gasPrice = await publicClient.getGasPrice();
      const bumpedGasPrice = (gasPrice * BigInt(100 + attempt * 15)) / 100n;

      const txHash = await walletClient.sendTransaction({ to, data, gas: gasLimit, gasPrice: bumpedGasPrice });

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

// ── Uniswap v4 + Clanker helpers ──────────────────────────────────────────────

const IS_MAINNET = process.env["BASE_NETWORK"] === "mainnet";

const UNISWAP_V4_ROUTER = (
  process.env["UNISWAP_V4_ROUTER_ADDRESS"] ?? "0x6ff5693b99212da76ad316178a184ab56d299b43"
) as Address;

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

export function buildUniswapV4SwapData(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  recipient: Address,
  poolInfo: ClankerPoolInfo,
): `0x${string}` {
  const SWAP_EXACT_IN_SINGLE = 0x06;
  const SETTLE_ALL = 0x0f;
  const TAKE_ALL = 0x11;

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

  const takeParams = encodeAbiParameters(
    [
      { name: "currency", type: "address" },
      { name: "recipient", type: "address" },
      { name: "minAmount", type: "uint256" },
    ],
    [tokenOut, recipient, 0n],
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
): Promise<{ routerAddress: Address; routerData: `0x${string}` }> {
  const clankerInfo = await fetchClankerPoolInfo(tokenIn, tokenOut);

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

// ── Direct ERC-20 transfer from deployer ─────────────────────────────────────

const ERC20_TRANSFER_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

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
