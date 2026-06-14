/**
 * Build a Base MCP / EIP-5792 wallet_sendCalls payload for vault operations.
 *
 * This is the "send_calls" execution path: GitHub confirm proves identity,
 * then the signed calldata is returned to the AI client which submits the
 * transaction via the user's Coinbase Wallet / Base Account.
 *
 * Security model:
 *   - No calldata is generated until AFTER GitHub identity confirm.
 *   - The destination address in gitUnshield is bound in ownerSig — an
 *     attacker who intercepts the execute token cannot redirect funds.
 *   - Execute tokens are single-use and expire in 10 minutes.
 *   - Even if submitted by the wrong wallet, funds go to user-specified
 *     addresses only (vault contract does not check msg.sender).
 */

import { encodeFunctionData, parseAbi, type Address } from "viem";
import {
  readVaultNonce,
  prepareVaultCalldata,
  toTokenUnits,
  buildSwapRouterData,
  computeSwapNetAmount,
} from "./relayer";
import { resolveToken } from "./tokens";

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export interface SendCallsItem {
  to: string;
  data: string;
  value: string;
}

export interface SendCallsPayload {
  calls: SendCallsItem[];
}

/**
 * Build the calls array for EIP-5792 wallet_sendCalls.
 *
 * deposit  → [ERC20.transfer(vault, amount), vault.gitShield(...)]
 * withdraw → [vault.gitUnshield(...)]
 * swap     → [vault.gitSwap(...)]
 */
export async function buildSendCallsPayload(
  command: "deposit" | "withdraw" | "swap",
  encryptedPk: string,
  vaultAddress: string,
  githubUserId: bigint,
  params: Record<string, unknown>,
): Promise<SendCallsPayload> {
  const vault = vaultAddress as Address;
  const nonce = await readVaultNonce(vault);

  if (command === "deposit") {
    const rawSymbol = params["token"] as string;
    const symbol = rawSymbol.toUpperCase() === "ETH" ? "WETH" : rawSymbol;
    const tokenInfo = resolveToken(symbol);
    if (!tokenInfo) throw new Error(`Unknown token: ${symbol}`);

    const amount = toTokenUnits(params["amount"] as number, tokenInfo.decimals);

    const transferData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [vault, amount],
    });

    const { data: shieldData } = await prepareVaultCalldata(
      encryptedPk, vault, githubUserId, "gitShield",
      [tokenInfo.address, amount, nonce],
    );

    return {
      calls: [
        { to: tokenInfo.address, data: transferData, value: "0x0" },
        { to: vault, data: shieldData, value: "0x0" },
      ],
    };
  }

  if (command === "withdraw") {
    const rawSymbol = params["token"] as string;
    const symbol = rawSymbol.toUpperCase() === "ETH" ? "WETH" : rawSymbol;
    const tokenInfo = resolveToken(symbol);
    if (!tokenInfo) throw new Error(`Unknown token: ${symbol}`);

    const amount = toTokenUnits(params["amount"] as number, tokenInfo.decimals);
    const destination = params["to_address"] as Address;

    const { data: unshieldData } = await prepareVaultCalldata(
      encryptedPk, vault, githubUserId, "gitUnshield",
      [tokenInfo.address, amount, destination, nonce],
    );

    return {
      calls: [
        { to: vault, data: unshieldData, value: "0x0" },
      ],
    };
  }

  if (command === "swap") {
    const inRaw = params["from_token"] as string;
    const outRaw = params["to_token"] as string;
    const inSymbol = inRaw.toUpperCase() === "ETH" ? "WETH" : inRaw;
    const outSymbol = outRaw.toUpperCase() === "ETH" ? "WETH" : outRaw;

    const tokenIn = resolveToken(inSymbol);
    const tokenOut = resolveToken(outSymbol);
    if (!tokenIn) throw new Error(`Unknown input token: ${inSymbol}`);
    if (!tokenOut) throw new Error(`Unknown output token: ${outSymbol}`);

    const grossAmount = toTokenUnits(params["amount"] as number, tokenIn.decimals);
    const swapAmount = computeSwapNetAmount(grossAmount);

    const { routerAddress, routerData } = await buildSwapRouterData(
      tokenIn.address, tokenOut.address, swapAmount, vault,
    );

    const { data: swapData } = await prepareVaultCalldata(
      encryptedPk, vault, githubUserId, "gitSwap",
      [tokenIn.address, tokenOut.address, swapAmount, 0n, routerAddress, routerData, nonce],
    );

    return {
      calls: [
        { to: vault, data: swapData, value: "0x0" },
      ],
    };
  }

  throw new Error(`send_calls not supported for command: ${command}`);
}
