/**
 * x-clanker.ts
 * Deploy tokens via Clanker v4 SDK on Base Mainnet.
 */

import { createPublicClient, createWalletClient, http, fallback } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { Clanker } from "clanker-sdk/v4";
import {
  POOL_POSITIONS,
  PoolPositions,
  FEE_CONFIGS,
  FeeConfigs,
  type ClankerTokenV4,
} from "clanker-sdk";
import { logger } from "./logger";

// Gitbank feeCollector — same address as deployer/feeCollector in GitVaultFactory
const GITBANK_FEE_COLLECTOR = "0x1e660A9A1f1F08AFEF9c03c96D66260122464CF2" as const;

export interface ClankerLaunchParams {
  name:               string;
  symbol:             string;
  imageUrl:           string;
  xUsername:          string;
  creatorVaultAddress: string;
  description?:       string;
}

export interface ClankerLaunchResult {
  tokenAddress: string;
  txHash:       string;
  shortLink:    string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function getDeployerAccount() {
  const pk = process.env["DEPLOYER_PRIVATE_KEY"] as `0x${string}` | undefined;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  return privateKeyToAccount(pk);
}

function buildClankerClient() {
  const account  = getDeployerAccount();
  const primaryRpc = process.env["BASE_RPC_URL"] ?? process.env["BASE_MAINNET_RPC_URL"];
  const transport = fallback([
    ...(primaryRpc ? [http(primaryRpc)] : []),
    http("https://mainnet.base.org"),
    http("https://base.llamarpc.com"),
    http("https://base-rpc.publicnode.com"),
  ]);
  const wallet   = createWalletClient({ account, chain: base, transport });
  const pub      = createPublicClient({ chain: base, transport });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Clanker({ wallet, publicClient: pub as any });
}

// ── main entry point ──────────────────────────────────────────────────────────

export async function launchClankerToken(
  params: ClankerLaunchParams,
): Promise<ClankerLaunchResult> {
  const account = getDeployerAccount();
  const clanker = buildClankerClient();

  const creatorVault = params.creatorVaultAddress as `0x${string}`;

  const token: ClankerTokenV4 = {
    name:        params.name,
    symbol:      params.symbol,
    image:       params.imageUrl,
    chainId:     8453,
    // deployer stays as tokenAdmin so we can update metadata if needed;
    // creator fees go directly to their Gitbank vault via rewards
    tokenAdmin:  account.address,
    metadata: {
      description:    params.description ?? `${params.name} — launched via @gitbankbot on X`,
      socialMediaUrls: [{ platform: "x", url: `https://x.com/${params.xUsername}` }],
    },
    context: {
      interface: "Gitbank X Bot",
      platform:  "Gitbank",
      id:        `x-${params.xUsername}-${Date.now()}`,
    },
    pool: {
      pairedToken:           "WETH",
      tickIfToken0IsClanker: POOL_POSITIONS[PoolPositions.Standard][0]!.tickLower,
      tickSpacing:           200,
      positions:             POOL_POSITIONS[PoolPositions.Standard],
    },
    fees: FEE_CONFIGS[FeeConfigs.DynamicBasic],
    // LP trading fees (in WETH) split between creator and Gitbank platform.
    // Effective from total trade fee:
    //   Clanker protocol: ~20% (hardcoded on-chain, cannot change)
    //   Creator vault:    ~64% (80% of remaining 80%)
    //   Gitbank platform: ~16% (20% of remaining 80%)
    // deposit-poller detects incoming WETH at creator's vault and auto-gitShields it → gitWETH.
    rewards: {
      recipients: [
        {
          admin:     account.address,
          recipient: creatorVault,        // ~64% of total fee → creator's Gitbank vault
          bps:       8000,
          token:     "Paired",            // WETH only
        },
        {
          admin:     account.address,
          recipient: GITBANK_FEE_COLLECTOR, // ~16% of total fee → Gitbank
          bps:       2000,
          token:     "Paired",
        },
      ],
    },
    vanity: false,
  };

  logger.info({ name: params.name, symbol: params.symbol, xUsername: params.xUsername }, "clanker: deploying token");

  const result = await clanker.deploy(token);

  if (result.error) {
    throw new Error(`Clanker deploy failed: ${result.error.message}`);
  }

  const { txHash, waitForTransaction } = result;

  logger.info({ txHash }, "clanker: tx submitted, waiting for receipt");

  const receipt = await waitForTransaction();

  if (receipt.error) {
    throw new Error(`Clanker deploy tx failed: ${receipt.error.message}`);
  }

  const tokenAddress = receipt.address;

  logger.info({ tokenAddress, txHash }, "clanker: token deployed");

  // Encode address as base64url so tweets never contain raw 0x strings (X auto-ban risk)
  const b64        = Buffer.from(tokenAddress.slice(2), "hex").toString("base64url");
  const shortLink  = `https://gitbank.io/api/c/${b64}`;

  return {
    tokenAddress,
    txHash,
    shortLink,
  };
}
