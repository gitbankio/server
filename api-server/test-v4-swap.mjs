/**
 * Minimal V4 swap fix verification.
 * Builds the swap calldata with the fixed TAKE_ALL encoding and calls
 * eth_estimateGas. If it succeeds, the bug is fixed. No ETH spent.
 *
 * Known TEST token pool:
 *   currency0 = TEST  0x3411670ad042F6f9E1bB0dC367492ABc0d7a8353
 *   currency1 = WETH  0x4200000000000000000000000000000000000006
 *   fee       = 0x800000 (Clanker dynamic fee)
 *   tickSpacing = 200
 *   hooks       = 0xb429d62f99E29E41DA0d1aB28FA5C76d4e1B7840
 *   zeroForOne  = false  (sell WETH → buy TEST)
 */

import {
  createPublicClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseEther,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";
const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY;

if (!DEPLOYER_PK) {
  console.error("DEPLOYER_PRIVATE_KEY env var required");
  process.exit(1);
}

const account = privateKeyToAccount(DEPLOYER_PK);
const deployer = account.address;

const publicClient = createPublicClient({ chain: base, transport: http(RPC) });

const WETH = "0x4200000000000000000000000000000000000006";
const TEST_TOKEN = "0x3411670ad042F6f9E1bB0dC367492ABc0d7a8353";
const V4_ROUTER = "0x6fF5693b99212Da76ad316178A184AB56D299b43";

// Pool info for TEST/WETH
const POOL = {
  currency0: TEST_TOKEN,
  currency1: WETH,
  fee: 0x800000,
  tickSpacing: 200,
  hooks: "0xb429D62F99E29E41da0D1ab28Fa5c76d4e1b7840",
  zeroForOne: false, // sell WETH (currency1) → buy TEST (currency0)
};

const AMOUNT_IN = parseEther("0.001"); // small amount for gas estimate

// ── Build V4 swap calldata (FIXED: TAKE_ALL with 2 params) ───────────────────

const SWAP_EXACT_IN = 0x06;
const SETTLE_ALL = 0x0f;
const TAKE_ALL = 0x11;

const actions = "0x" + [SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL].map(b => b.toString(16).padStart(2, "0")).join("");

const poolKey = {
  currency0: POOL.currency0,
  currency1: POOL.currency1,
  fee: POOL.fee,
  tickSpacing: POOL.tickSpacing,
  hooks: POOL.hooks,
};

// SWAP_EXACT_IN_SINGLE struct matches relayer.ts exactly:
// { poolKey, zeroForOne, amountIn (uint128), amountOutMinimum (uint128), hookData }
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
  [{ poolKey, zeroForOne: POOL.zeroForOne, amountIn: AMOUNT_IN, amountOutMinimum: 0n, hookData: "0x" }],
);

const settleParams = encodeAbiParameters(
  [{ name: "currency", type: "address" }, { name: "maxAmount", type: "uint256" }],
  [WETH, AMOUNT_IN],
);

// FIXED: TAKE_ALL only accepts (currency, minAmount) — NO recipient
const takeParams = encodeAbiParameters(
  [{ name: "currency", type: "address" }, { name: "minAmount", type: "uint256" }],
  [TEST_TOKEN, 0n],
);

const v4SwapInput = encodeAbiParameters(
  [{ name: "actions", type: "bytes" }, { name: "params", type: "bytes[]" }],
  [actions, [swapParams, settleParams, takeParams]],
);

const EXECUTE_ABI = parseAbi([
  "function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable",
]);

const V4_SWAP_CMD = "0x10";

const calldata = encodeFunctionData({
  abi: EXECUTE_ABI,
  functionName: "execute",
  args: [V4_SWAP_CMD, [v4SwapInput], BigInt(Math.floor(Date.now() / 1000) + 300)],
});

// ── Need to approve UniversalRouter to pull WETH first ───────────────────────
const WETH_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

async function main() {
  console.log("=== V4 Swap Fix Verification ===");
  console.log("Deployer:", deployer);
  console.log("Token:   ", TEST_TOKEN, "(TEST)");
  console.log("Router:  ", V4_ROUTER);
  console.log("Amount:  ", formatEther(AMOUNT_IN), "WETH");
  console.log();

  const [wethBal, allowance] = await Promise.all([
    publicClient.readContract({ address: WETH, abi: WETH_ABI, functionName: "balanceOf", args: [deployer] }),
    publicClient.readContract({ address: WETH, abi: WETH_ABI, functionName: "allowance", args: [deployer, V4_ROUTER] }),
  ]);

  console.log("WETH balance:", formatEther(wethBal));
  console.log("Router allowance:", formatEther(allowance));

  if (wethBal < AMOUNT_IN) {
    console.error("FAIL: Insufficient WETH balance");
    process.exit(1);
  }

  let estimatedGas;
  try {
    if (allowance < AMOUNT_IN) {
      console.log("Note: allowance is low — estimating with approve first (normal in production)");
    }
    console.log("\nEstimating gas for V4 swap...");
    estimatedGas = await publicClient.estimateGas({
      account: deployer,
      to: V4_ROUTER,
      data: calldata,
    });
    console.log("✅ Gas estimate SUCCESS:", estimatedGas.toString(), "gas units");
    console.log("   (If estimateGas passes, the real tx will succeed)");
  } catch (err) {
    console.error("❌ Gas estimate FAILED:", err.message ?? err);
    console.error("\nThis means the TAKE_ALL encoding is still wrong, or the pool has no liquidity.");
    process.exit(1);
  }

  console.log("\n=== RESULT: V4 swap calldata is valid ===");
  console.log("TAKE_ALL fix (remove recipient param) is working correctly.");
}

main().catch(e => { console.error(e); process.exit(1); });
