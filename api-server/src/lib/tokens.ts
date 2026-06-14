import type { Address } from "viem";

export interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
  swapOutputAllowed: boolean;
}

// WETH is the same address on Base mainnet and Base Sepolia (system contract).
const WETH: Address = "0x4200000000000000000000000000000000000006";

const TOKENS_SEPOLIA: TokenInfo[] = [
  { symbol: "WETH", address: WETH,                                              decimals: 18, swapOutputAllowed: true  },
  { symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",     decimals: 6,  swapOutputAllowed: true  },
];

const TOKENS_MAINNET: TokenInfo[] = [
  { symbol: "WETH",  address: WETH,                                             decimals: 18, swapOutputAllowed: true  },
  { symbol: "USDC",  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",    decimals: 6,  swapOutputAllowed: true  },
  { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",    decimals: 8,  swapOutputAllowed: false },
];

function getTokenList(): TokenInfo[] {
  return process.env["BASE_NETWORK"] === "mainnet" ? TOKENS_MAINNET : TOKENS_SEPOLIA;
}

/** Return all supported tokens for the current network. */
export function getAllTokens(): TokenInfo[] {
  return getTokenList();
}

/** Resolve a symbol (case-insensitive) to its TokenInfo. Returns undefined if unknown. */
export function resolveToken(symbol: string): TokenInfo | undefined {
  return getTokenList().find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
}

/** Resolve a symbol to its on-chain address. Throws if the symbol is unknown. */
export function requireTokenAddress(symbol: string): Address {
  const token = resolveToken(symbol);
  if (!token) {
    const known = getTokenList().map((t) => t.symbol).join(", ");
    throw new Error(`Unknown token "${symbol}". Supported: ${known}`);
  }
  return token.address;
}

/** Return all tokens that are allowed as swap output (gitSwap tokenOut). */
export function swapOutputTokens(): TokenInfo[] {
  return getTokenList().filter((t) => t.swapOutputAllowed);
}

/** Validate that a given address is an allowed swap output. */
export function isSwapOutputAllowed(address: Address): boolean {
  return getTokenList().some(
    (t) => t.swapOutputAllowed && t.address.toLowerCase() === address.toLowerCase()
  );
}
