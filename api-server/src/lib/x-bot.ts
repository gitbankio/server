import Anthropic from "@anthropic-ai/sdk";
import { db, xUsersTable, transactionsTable, pendingDepositsTable, launchedTokensTable, x402ResultsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { type Address, keccak256, encodePacked, isAddress } from "viem";
import {
  callVault,
  lockDeposit,
  readVaultNonce,
  readVaultBalance,
  readVaultAvailableDeposit,
  getVaultByGithubId,
  buildSwapRouterData,
  toTokenUnits,
  computeSwapNetAmount,
  deployVault,
  fetchX402Requirements,
  computeUnshieldGrossForNet,
  x402AtomicToHuman,
  getDeployerAddress,
  waitForTxConfirmation,
  signEip3009Authorization,
  sendX402Request,
} from "./relayer";
import { generateKeypair, encryptPrivateKey } from "./key-engine";
import { resolveToken, getAllTokens } from "./tokens";
import { postThread, lookupUser } from "./x-client";
import { launchClankerToken } from "./x-clanker";
import { type LiveData, fetchLiveData } from "./x-data";
import { logger } from "./logger";

const anthropic = new Anthropic({
  apiKey:   process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"]  ?? "",
  baseURL:  process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"] ?? undefined,
});

const EXPLORER     = process.env["BASE_NETWORK"] === "mainnet"
  ? "https://basescan.org/tx"
  : "https://sepolia.basescan.org/tx";
const NETWORK_LABEL = process.env["BASE_NETWORK"] === "mainnet" ? "Base Mainnet" : "Base Sepolia";
const DEX_ROUTER    = process.env["DEX_ROUTER_ADDRESS"] ?? "";

// ── Rate limiter: 10 commands/hour per x_user_id ─────────────────────────────

const rateLimiter = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(xUserId: string): boolean {
  const now  = Date.now();
  const entry = rateLimiter.get(xUserId);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(xUserId, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

// ── Account age guard: skip accounts < 10 days old ───────────────────────────

export function isTooNew(createdAt: string): boolean {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return ageMs < 10 * 24 * 60 * 60 * 1000;
}

// ── Intent parser ─────────────────────────────────────────────────────────────

interface XIntent {
  intent:         "deposit" | "withdraw" | "swap" | "transfer" | "balance" | "launch" | "help" | "qa" | "unknown" | "x402_pay";
  token_in:       string | null;
  token_out:      string | null;
  amount:         number | null;
  recipient:      string | null;
  token_name:     string | null;
  token_symbol:   string | null;
  confidence:     number;
  x402_url?:      string | null;
  provider_handle?: string | null;
  search_query?:  string | null;
}

// Named x402 providers — @mention resolves to endpoint + request body builder.
// Exa: x402-native, confirmed at https://api.exa.ai/search (POST, {query, numResults}).
// buildBody returns null to let relayer fall back to bazaar body from the 402 response.
const PROVIDER_HANDLES: Record<string, { url: string; buildBody: (q: string) => object | null }> = {
  "@exaailabs": {
    url:       "https://api.exa.ai/search",
    buildBody: (q) => ({ query: q || "web3 defi crypto", numResults: 5, type: "auto" }),
  },
  "@nansen_ai": {
    url:       "https://api.nansen.ai/api/v1/smart-money/netflow",
    buildBody: () => null, // bazaar extension in relayer.ts supplies the body (chains:all, filters, pagination)
  },
};

const INTENT_SYSTEM = `You are the Gitbank X bot intent parser. Extract structured intent from a tweet mentioning @gitbankbot.

Return ONLY valid JSON with this exact shape:
{
  "intent": "deposit"|"withdraw"|"swap"|"transfer"|"balance"|"launch"|"x402_pay"|"help"|"qa"|"unknown",
  "token_in": "USDC"|"WETH"|null,
  "token_out": "USDC"|"WETH"|null,
  "amount": number|null,
  "recipient": "@username or 0xAddress"|null,
  "token_name": string|null,
  "token_symbol": string|null,
  "confidence": 0.0..1.0,
  "x402_url": "https://..." or null,
  "provider_handle": "@exaailabs"|"@nansen_ai"|null,
  "search_query": string|null
}

Rules:
- deposit/withdraw/swap/transfer/balance/help = vault commands
- launch = user wants to deploy/create/launch a new token via Clanker
- x402_pay = "x402-pay", "pay this API", "pay via x402", "pay URL" — two forms:
  1. Direct URL: "@gitbankbot x402-pay https://api.example.com/data 0.01 USDC" -> intent="x402_pay", x402_url="https://api.example.com/data", amount=0.01, token_in="USDC", provider_handle=null, search_query=null
  2. Named provider @mention: "@gitbankbot x402-pay @ExaAILabs \"DeFi protocols\" 0.01 USDC" -> intent="x402_pay", x402_url=null, provider_handle="@exaailabs", search_query="DeFi protocols", amount=0.01, token_in="USDC"
  3. Named provider @mention: "@gitbankbot x402-pay @nansen_ai \"0xABC...\" 0.01 USDC" -> intent="x402_pay", x402_url=null, provider_handle="@nansen_ai", search_query="0xABC...", amount=0.01, token_in="USDC"
- For provider @mentions: extract provider_handle (lowercase, exact @handle like "@exaailabs" or "@nansen_ai") and search_query (the text after the handle, before the amount)
- qa = question about Gitbank (not a vault command)
- unknown = irrelevant noise
- ETH → WETH
- For launch: extract token_name (full name) and token_symbol (ticker like $XYZ or XYZ, without $)
- For "withdraw": recipient = the destination wallet address (0x hex string, no @ prefix). Example: "0xAbCd...1234"
- For "transfer": recipient = @username of the recipient X account
- If tweet says "send to this guy", "send to them", "tip this person" etc. and a PARENT TWEET CONTEXT is provided, resolve recipient to the parent tweet's author (@username).
- No explanation. Return JSON only.`;

async function parseXIntent(
  text: string,
  parentTweet?: { text: string; authorUsername: string } | null,
): Promise<XIntent> {
  const userContent = parentTweet
    ? `Parent tweet by @${parentTweet.authorUsername}: "${parentTweet.text}"\n\nMention: ${text}`
    : text;
  try {
    const msg = await anthropic.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 256,
      system:     INTENT_SYSTEM,
      messages:   [{ role: "user", content: userContent }],
    });
    const raw   = msg.content[0]?.type === "text" ? msg.content[0].text : "{}";
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    return JSON.parse(clean) as XIntent;
  } catch {
    return { intent: "unknown", token_in: null, token_out: null, amount: null, recipient: null, token_name: null, token_symbol: null, confidence: 0 };
  }
}

// ── Q&A system ────────────────────────────────────────────────────────────────

const QA_SYSTEM = (data: LiveData) => `You are @gitbankbot, the official X bot for Gitbank.

Gitbank is a soul-bound vault infrastructure for AI agents and developers on Base L2.
Vaults are deployed per GitHub/X user ID. Assets inside become gitAssets (gitUSDC, gitWETH).
gitAssets cannot be transferred without 2 signatures (owner + relayer). No approve surface. Not drainable with a stolen key alone.
Bot commands run via @gitbankbot mentions. Zero gas for users (relayer pays all gas).
Contracts live on Base Mainnet. GitVaultFactory: 0xAA0a4ff46733EBaE8E658642A1314f18980fc77B.
AutoGit Hackathon Event 1: 100/100 slots filled, 139 forks, 500 gitUSDC paid on-chain, fully automated.
Event 2 "Hack the Vault" coming soon: publish a private key with gitAssets inside, try to drain it — key alone is not enough.
Commands: deposit, withdraw, swap (Uniswap v3), send (2-step transfer), balance.

LIVE DATA (as of this moment):
- GITBANK token price: ${data.price} (24h: ${data.priceChange})
- 24h volume: ${data.volume24h} | Liquidity: ${data.liquidity}
- Total vaults deployed: ${data.vaultCount}
- Total on-chain transactions: ${data.txCount}
- X bot users: ${data.xUserCount}

LANGUAGE RULES:
- Detect the language of the user's message
- Default response language: English
- If user writes in Arabic, Chinese (Mandarin/Cantonese/Traditional), Japanese, Korean, Thai, Vietnamese, Russian, Spanish, French, German, Portuguese, or any non-English language — respond in THAT language
- Never mix languages in a single response

OTHER RULES (never break):
- Never mention Replit, replit.md, or any internal tooling
- Never reveal team member names, identities, or locations
- Never fabricate data — if you do not know, say so
- Keep response under 250 characters unless a thread is needed
- Be direct, technical, confident. No fluff.
- No em dash character in output
- NEVER ask follow-up questions or prompt the user to reply. The bot only reads tweets that directly @gitbankbot — it cannot read replies that do not mention it. If the user's message looks like an incomplete command, show them the correct syntax with @gitbankbot in it.
- If message looks like a vault command (deposit/withdraw/swap/send/balance) but is missing params, respond with: "@username To deposit: @gitbankbot deposit 10 USDC" (adapt to the detected command). Never ask "what's the amount?" or similar.`;

async function handleQA(
  text: string,
  username: string,
  tweetId: string,
  parentTweet?: { text: string; authorUsername: string } | null,
): Promise<void> {
  const data = await fetchLiveData();
  const userContent = parentTweet
    ? `Context — parent tweet by @${parentTweet.authorUsername}: "${parentTweet.text}"\n\n@${username} asks: ${text}`
    : `@${username} asks: ${text}`;
  try {
    const msg = await anthropic.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 512,
      system:     QA_SYSTEM(data),
      messages:   [{ role: "user", content: userContent }],
    });
    const reply = msg.content[0]?.type === "text" ? msg.content[0].text : "Check gitbank.io for more info.";
    await postThread(reply, tweetId);
  } catch (err) {
    logger.error({ err }, "handleQA error");
  }
}

// ── Launch handler (Clanker) ──────────────────────────────────────────────────

async function handleLaunch(
  intent:          XIntent,
  xUser:           { encryptedPk: string; vaultAddress: string; xUserId: string },
  username:        string,
  tweetId:         string,
  mediaUrl?:       string | null,
  parentMediaUrl?: string | null,
  parentAuthorPfp?: string | null,
): Promise<void> {
  const name   = intent.token_name?.trim()   ?? "";
  const symbol = intent.token_symbol?.trim() ?? "";

  if (!name || !symbol) {
    await postThread(
      `@${username} Include token name and ticker. Example:\n@gitbankbot launch My Token $MTK`,
      tweetId,
    );
    return;
  }

  // Logo priority: own tweet attachment > parent tweet media > parent author pfp > ask retry
  const logoUrl = mediaUrl ?? parentMediaUrl ?? parentAuthorPfp ?? null;
  if (!logoUrl) {
    await postThread(
      `@${username} No image found. Reply to a post with an image, or attach a logo to your tweet:\n` +
      `@gitbankbot launch ${name} $${symbol}`,
      tweetId,
    );
    return;
  }

  await postThread(
    `@${username} Deploying ${name} ($${symbol}) on Base via Clanker... this takes ~30s.`,
    tweetId,
  );

  try {
    const result = await launchClankerToken({
      name,
      symbol,
      imageUrl:            logoUrl,
      xUsername:           username,
      creatorVaultAddress: xUser.vaultAddress,
    });

    // Persist to launchpad DB so token appears on gitbank.io/x (best-effort)
    try {
      await db.insert(launchedTokensTable).values({
        tokenName:           name,
        tokenSymbol:         symbol,
        contractAddress:     result.tokenAddress,
        deployerGithubLogin: username,
        deployerGithubId:    Number(BigInt(xUser.xUserId)),
        txHash:              result.txHash,
        chainId:             8453,
        imageUrl:            logoUrl ?? null,
        twitterUrl:          `https://x.com/${username}`,
      }).onConflictDoNothing();
    } catch (dbErr) {
      logger.warn({ dbErr, name, symbol }, "handleLaunch: failed to persist token to DB");
    }

    await postThread(
      `@${username} ${name} $${symbol} is live on Base, deployed via @clanker_world\n` +
      `${result.shortLink}`,
      tweetId,
    );
  } catch (err) {
    logger.error({ err, name, symbol, username }, "handleLaunch error");
    await postThread(
      `@${username} Token launch failed. Please try again in a few minutes.`,
      tweetId,
    );
  }
}

// ── Vault helpers ─────────────────────────────────────────────────────────────

async function getOrDeployXVault(xUserId: string, xUsername: string): Promise<{
  encryptedPk: string;
  vaultAddress: string;
  xUserId: string;
} | null> {
  const existing = await db.select().from(xUsersTable).where(eq(xUsersTable.xUserId, xUserId)).limit(1);

  if (existing[0]?.vaultAddress && existing[0]?.encryptedPk) {
    return {
      encryptedPk:  existing[0].encryptedPk,
      vaultAddress: existing[0].vaultAddress,
      xUserId,
    };
  }

  // Deploy new vault
  const kp    = generateKeypair();
  const encPk = encryptPrivateKey(kp.privateKey);
  const xId   = BigInt(xUserId);

  if (!existing[0]) {
    await db.insert(xUsersTable).values({
      xUserId,
      xUsername,
      ownerAddress: kp.address,
      encryptedPk:  encPk,
    });
  } else {
    await db.update(xUsersTable)
      .set({ ownerAddress: kp.address, encryptedPk: encPk })
      .where(eq(xUsersTable.xUserId, xUserId));
  }

  try {
    await deployVault(encPk, xId, kp.address as Address);
  } catch (err) {
    logger.error({ err, xUserId }, "x-bot deployVault failed");
    return null;
  }

  // Poll until vault address resolves (Base ~2s blocks, max ~40s)
  let vaultAddress: string | null = null;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const addr = await getVaultByGithubId(xId);
      if (addr && addr !== "0x0000000000000000000000000000000000000000") {
        vaultAddress = addr;
        break;
      }
    } catch {}
  }

  if (!vaultAddress) return null;

  await db.update(xUsersTable)
    .set({ vaultAddress })
    .where(eq(xUsersTable.xUserId, xUserId));

  return { encryptedPk: encPk, vaultAddress, xUserId };
}

function encodeTxUrl(txHash: string): string {
  const b64 = Buffer.from(txHash.slice(2), "hex").toString("base64url");
  return `https://gitbank.io/api/t/${b64}`;
}

/**
 * Format a token amount for display using floor division (never rounds up).
 * Prevents "you have X but can't withdraw X" UX bugs caused by toFixed rounding.
 */
function floorDisplay(amountWei: bigint, decimals: number): string {
  const displayDecimals = decimals <= 6 ? 2 : 6;
  const divisor = 10n ** BigInt(decimals - displayDecimals);
  const floored = amountWei / divisor; // BigInt floor division
  return (Number(floored) / 10 ** displayDecimals).toFixed(displayDecimals);
}

/** Tolerance for capping amountWei to vaultBal: 1 unit at 6 display decimal places. */
function displayTolerance(decimals: number): bigint {
  return 10n ** BigInt(Math.max(0, decimals - 6));
}

function xReceipt(operation: string, txHash: string, extra: string[] = [], vaultUrl?: string): string {
  const lines = [
    `${operation} confirmed.`,
    `Tx: ...${txHash.slice(-10)}`,
    encodeTxUrl(txHash),
    ...extra,
    ...(vaultUrl ? [vaultUrl] : []),
    `Network: ${NETWORK_LABEL} | Gas: Gitbank Relayer`,
  ];
  return lines.join("\n");
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function registerPendingXDeposit(
  xUserId: string,
  vault: Address,
  token: { address: Address; symbol: string; decimals: number },
  amountWei: bigint,
  username: string,
  tweetId: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(pendingDepositsTable).values({
    xUserId,
    trackingAddress: vault,
    token:           token.address,
    tokenSymbol:     token.symbol,
    amountExpected:  amountWei.toString(),
    issueNumber:     0,
    repo:            "x-bot",
    installationId:  0,
    senderLogin:     username,
    commentId:       tweetId,
    expiresAt,
  }).onConflictDoUpdate({
    target: [pendingDepositsTable.trackingAddress, pendingDepositsTable.token],
    set: { xUserId, amountExpected: amountWei.toString(), expiresAt, commentId: tweetId },
  });
}

async function handleDeposit(
  intent: XIntent,
  xUser: { encryptedPk: string; vaultAddress: string; xUserId: string },
  username: string,
  tweetId: string,
): Promise<void> {
  const vault = xUser.vaultAddress as Address;
  const xId   = BigInt(xUser.xUserId);

  const sym    = (intent.token_in ?? "").toUpperCase().trim();
  const rawSymbol = sym === "ETH" ? "WETH" : sym;          // exact match only — avoids "WETH"→"WWETH"
  const token     = rawSymbol ? resolveToken(rawSymbol) : null;

  // Case 1: specific token + specific amount
  if (token && intent.amount && intent.amount > 0) {
    const amountWei = toTokenUnits(intent.amount, token.decimals);

    let available = 0n;
    try { available = await readVaultAvailableDeposit(vault, token.address); } catch {}

    if (available >= amountWei) {
      // Already enough in vault — shield immediately
      const nonce  = await readVaultNonce(vault);
      const result = await lockDeposit(xUser.encryptedPk, vault, xId, token.address, amountWei, nonce);
      await db.insert(transactionsTable).values({
        type:    "lock",
        githubId: Number(xId),
        tokenIn:  token.address,
        amountIn: amountWei.toString(),
        txHash:   result.txHash,
        status:   "pending",
      });
      await postThread(
        `@${username} ` + xReceipt("Deposit", result.txHash, [`${intent.amount} ${token.symbol} locked.`], `https://gitbank.io/v/${xUser.xUserId}?tweet=${tweetId}`),
        tweetId,
      );
      return;
    }

    // Not enough — ask user to send, then wait
    const stillNeeded = (Number(amountWei - available) / 10 ** token.decimals)
      .toFixed(token.decimals === 6 ? 2 : 6);
    const vaultUrl = `https://gitbank.io/v/${xUser.xUserId}?tweet=${tweetId}`;
    await postThread(
      `@${username} Send ${stillNeeded} ${token.symbol} to your vault:\n${vaultUrl}\n` +
      `Gitbank auto-shields within 30s.`,
      tweetId,
    );
    await registerPendingXDeposit(xUser.xUserId, vault, token, amountWei, username, tweetId);
    return;
  }

  // Case 2: token specified, no amount — accept any incoming amount
  if (token) {
    const vaultUrl = `https://gitbank.io/v/${xUser.xUserId}?tweet=${tweetId}`;
    await postThread(
      `@${username} Send any amount of ${token.symbol} to your vault:\n${vaultUrl}\n` +
      `Gitbank auto-shields within 30s.`,
      tweetId,
    );
    await registerPendingXDeposit(xUser.xUserId, vault, token, 0n, username, tweetId);
    return;
  }

  // Case 3: no token, no amount — accept USDC or WETH, whichever arrives first
  const tokens = getAllTokens();
  const vaultUrl = `https://gitbank.io/v/${xUser.xUserId}?tweet=${tweetId}`;
  await postThread(
    `@${username} Your vault on Base:\n${vaultUrl}\n` +
    `Send USDC or WETH — Gitbank auto-shields within 30s.\n` +
    `Network: ${NETWORK_LABEL} | Gas: Gitbank Relayer`,
    tweetId,
  );
  for (const t of tokens) {
    await registerPendingXDeposit(xUser.xUserId, vault, t, 0n, username, tweetId);
  }
}

async function handleWithdraw(
  intent: XIntent,
  xUser: { encryptedPk: string; vaultAddress: string; xUserId: string },
  username: string,
  tweetId: string,
): Promise<void> {
  const symbol = intent.token_in ?? "";
  const token  = resolveToken(symbol === "ETH" ? "WETH" : symbol);
  if (!token) {
    await postThread(`@${username} Unknown token. Supported: USDC, WETH.`, tweetId);
    return;
  }
  if (!intent.amount || intent.amount <= 0) {
    await postThread(`@${username} Specify amount and destination. Example: @gitbankbot withdraw 10 USDC to 0xYourAddress`, tweetId);
    return;
  }
  const destination = intent.recipient ?? null;
  if (!destination || !isAddress(destination)) {
    await postThread(`@${username} Include destination address. Example: @gitbankbot withdraw ${intent.amount} ${token.symbol} to 0xYourAddress`, tweetId);
    return;
  }

  const vault     = xUser.vaultAddress as Address;
  let   amountWei = toTokenUnits(intent.amount, token.decimals);
  const xId       = BigInt(xUser.xUserId);

  // Balance check — cap to vault balance if user requested more
  let vaultBal = 0n;
  try { vaultBal = await readVaultBalance(vault, token.address); } catch {}
  if (vaultBal === 0n) {
    await postThread(`@${username} Vault has no ${token.symbol} to withdraw.`, tweetId);
    return;
  }
  let cappedNote = "";
  if (amountWei > vaultBal) {
    cappedNote = `Only ${floorDisplay(vaultBal, token.decimals)} ${token.symbol} available. Used full balance.`;
    amountWei = vaultBal;
  }

  const nonce     = await readVaultNonce(vault);
  const result = await callVault(xUser.encryptedPk, vault, xId, "gitUnshield", [
    token.address, amountWei, destination as Address, nonce,
  ]);

  await db.insert(transactionsTable).values({
    type:     "unlock",
    githubId:  Number(xId),
    tokenOut:  token.address,
    amountOut: amountWei.toString(),
    txHash:    result.txHash,
    status:    "pending",
  });

  const withdrawExtra = [`Amount: ${floorDisplay(amountWei, token.decimals)} ${token.symbol}`, `To: ...${(destination as string).slice(-6)}`];
  if (cappedNote) withdrawExtra.push(cappedNote);
  await postThread(
    `@${username} ` + xReceipt("Withdraw", result.txHash, withdrawExtra),
    tweetId,
  );
}

async function handleSwap(
  intent: XIntent,
  xUser: { encryptedPk: string; vaultAddress: string; xUserId: string },
  username: string,
  tweetId: string,
): Promise<void> {
  if (!DEX_ROUTER) {
    await postThread(`@${username} Swap unavailable right now. Try again later.`, tweetId);
    return;
  }
  const tokenIn  = resolveToken((intent.token_in ?? "") === "ETH" ? "WETH" : (intent.token_in ?? ""));
  const tokenOut = resolveToken((intent.token_out ?? "") === "ETH" ? "WETH" : (intent.token_out ?? ""));
  if (!tokenIn || !tokenOut) {
    await postThread(`@${username} Invalid token pair. Supported: USDC, WETH.`, tweetId);
    return;
  }
  if (!tokenOut.swapOutputAllowed) {
    await postThread(`@${username} "${intent.token_out}" not allowed as swap output. Use USDC or WETH.`, tweetId);
    return;
  }
  if (!intent.amount || intent.amount <= 0) {
    await postThread(`@${username} Specify amount. Example: @gitbankbot swap 10 USDC to WETH`, tweetId);
    return;
  }

  const vault        = xUser.vaultAddress as Address;
  const xId          = BigInt(xUser.xUserId);
  let   amountWei    = toTokenUnits(intent.amount, tokenIn.decimals);

  // Balance check — cap to vault balance if user requested more
  let swapBal = 0n;
  try { swapBal = await readVaultBalance(vault, tokenIn.address); } catch {}
  if (swapBal === 0n) {
    await postThread(`@${username} Vault has no ${tokenIn.symbol} to swap.`, tweetId);
    return;
  }
  let swapCappedNote = "";
  if (amountWei > swapBal) {
    swapCappedNote = `Only ${floorDisplay(swapBal, tokenIn.decimals)} ${tokenIn.symbol} available. Used full balance.`;
    amountWei = swapBal;
  }

  const netAmount    = computeSwapNetAmount(amountWei);
  const { routerAddress, routerData } = await buildSwapRouterData(tokenIn.address, tokenOut.address, netAmount, vault);
  const nonce        = await readVaultNonce(vault);

  const result = await callVault(xUser.encryptedPk, vault, xId, "gitSwap", [
    tokenIn.address, tokenOut.address, amountWei, 0n,
    routerAddress as Address, routerData as `0x${string}`, nonce,
  ]);

  await db.insert(transactionsTable).values({
    type:    "swap",
    githubId: Number(xId),
    tokenIn:  tokenIn.address,
    amountIn: amountWei.toString(),
    txHash:   result.txHash,
    status:   "pending",
  });

  const swapExtra = [`From: ${floorDisplay(amountWei, tokenIn.decimals)} ${tokenIn.symbol}`, `To: ${tokenOut.symbol}`];
  if (swapCappedNote) swapExtra.push(swapCappedNote);
  await postThread(
    `@${username} ` + xReceipt("Swap", result.txHash, swapExtra),
    tweetId,
  );
}

async function handleTransfer(
  intent: XIntent,
  xUser: { encryptedPk: string; vaultAddress: string; xUserId: string },
  username: string,
  tweetId: string,
): Promise<void> {
  const symbol = intent.token_in ?? "";
  const token  = resolveToken(symbol === "ETH" ? "WETH" : symbol);
  if (!token || !intent.amount || intent.amount <= 0) {
    await postThread(`@${username} Specify token, amount and recipient. Example: @gitbankbot send 10 USDC to @alice`, tweetId);
    return;
  }

  const recipientHandle = (intent.recipient ?? "").replace("@", "");
  if (!recipientHandle) {
    await postThread(`@${username} Specify recipient. Example: @gitbankbot send 10 USDC to @alice`, tweetId);
    return;
  }

  // Resolve recipient X user
  const recipientXInfo = await lookupUser(recipientHandle);
  if (!recipientXInfo) {
    await postThread(`@${username} Could not find X user @${recipientHandle}.`, tweetId);
    return;
  }

  const vault      = xUser.vaultAddress as Address;
  const xId        = BigInt(xUser.xUserId);
  let   amountWei  = toTokenUnits(intent.amount, token.decimals);

  // Balance check — cap to vault balance if user requested more
  let sendBal = 0n;
  try { sendBal = await readVaultBalance(vault, token.address); } catch {}
  if (sendBal === 0n) {
    await postThread(`@${username} Vault has no ${token.symbol} to send.`, tweetId);
    return;
  }
  let sendCappedNote = "";
  if (amountWei > sendBal) {
    sendCappedNote = `Only ${floorDisplay(sendBal, token.decimals)} ${token.symbol} available. Used full balance.`;
    amountWei = sendBal;
  }

  // Deploy recipient vault only if they don't have one yet
  const existingRecipient = await db.select().from(xUsersTable)
    .where(eq(xUsersTable.xUserId, recipientXInfo.id)).limit(1);
  if (!existingRecipient[0]?.vaultAddress) {
    await postThread(`@${username} @${recipientHandle} does not have a vault yet. Deploying one now...`, tweetId);
  }

  const recipientVaultData = await getOrDeployXVault(recipientXInfo.id, recipientXInfo.username);
  if (!recipientVaultData) {
    await postThread(`@${username} Could not deploy vault for @${recipientHandle}. Try again in 30 seconds.`, tweetId);
    return;
  }

  const to         = recipientVaultData.vaultAddress as Address;

  const initNonce = await readVaultNonce(vault);
  const initHash  = keccak256(encodePacked(
    ["uint256", "address", "address", "uint256"],
    [initNonce, token.address, to, amountWei],
  ));
  await callVault(xUser.encryptedPk, vault, xId, "initTransfer", [initHash]);

  let finalNonce = initNonce;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    finalNonce = await readVaultNonce(vault);
    if (finalNonce > initNonce) break;
  }

  const result = await callVault(xUser.encryptedPk, vault, xId, "finalizeTransfer", [
    token.address, to, amountWei, finalNonce, initNonce,
  ]);

  await db.insert(transactionsTable).values({
    type:     "transfer",
    githubId:  Number(xId),
    tokenOut:  token.address,
    amountOut: amountWei.toString(),
    txHash:    result.txHash,
    status:    "pending",
  });

  const actualAmt = floorDisplay(amountWei, token.decimals);
  const transferExtra = [`Amount: ${actualAmt} ${token.symbol}`, `To: @${recipientHandle}`];
  if (sendCappedNote) transferExtra.push(sendCappedNote);
  await postThread(
    `@${username} ` + xReceipt("Transfer", result.txHash, transferExtra) +
    `\n\n@${recipientHandle} You received ${actualAmt} ${token.symbol} from @${username}. Reply @gitbankbot balance to check.`,
    tweetId,
  );
}

async function handleBalance(
  xUser: { encryptedPk: string; vaultAddress: string; xUserId: string },
  username: string,
  tweetId: string,
): Promise<void> {
  const vault  = xUser.vaultAddress as Address;
  const tokens = getAllTokens();
  const lines: string[] = [`@${username} Vault: ${vault.slice(0, 10)}...`];

  for (const token of tokens) {
    try {
      const bal = await readVaultBalance(vault, token.address);
      lines.push(`git${token.symbol}: ${floorDisplay(bal, token.decimals)}`);
    } catch {}
  }

  await postThread(lines.join("\n"), tweetId);
}

async function formatX402Response(url: string, responseBody: string, status: number): Promise<string> {
  if (!responseBody || responseBody.length === 0) return "";
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2048,
      system: [
        "You are a data formatter. Given a raw JSON API response, produce a complete human-readable summary in English.",
        "Rules:",
        "- If the response contains a list/array, show ALL items as a markdown table.",
        "- Include the most useful fields (name, symbol, amount, price, change, volume, score, url, title, etc).",
        "- Use plain text and markdown tables only. No code blocks.",
        "- Do not truncate, cut, or summarize — show everything from the response.",
        "- If the response is an error or non-data, just write one line explaining it.",
        "- Do not include the raw JSON.",
      ].join(" "),
      messages: [{
        role: "user",
        content: `API URL: ${url}\nHTTP Status: ${status}\n\nResponse:\n${responseBody}`,
      }],
    });
    const text = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
    return text;
  } catch {
    return "";
  }
}

function extractTweetSummary(responseBody: string): string | null {
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;

    // Nansen: data[].token_symbol → "$LIT $TRUMP $KINS ..."
    const dataArr = obj["data"];
    if (Array.isArray(dataArr) && dataArr.length > 0) {
      const first = dataArr[0] as Record<string, unknown>;
      if (typeof first["token_symbol"] === "string") {
        const tickers = (dataArr as Record<string, unknown>[])
          .map((r) => r["token_symbol"])
          .filter((s): s is string => typeof s === "string" && s.length > 0)
          .map((s) => `$${s}`)
          .join(" ");
        return tickers ? `Smart money: ${tickers}` : null;
      }
    }

    // Exa: results[].title → first result title + hostname
    const results = obj["results"];
    if (Array.isArray(results) && results.length > 0) {
      const first = results[0] as Record<string, unknown>;
      if (typeof first["title"] === "string") {
        const title = (first["title"] as string).slice(0, 80);
        try {
          const host = new URL(first["url"] as string).hostname;
          return `${title} (${host})`;
        } catch {
          return title;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function handleX402Pay(
  intent: XIntent,
  xUser: { encryptedPk: string; vaultAddress: string; xUserId: string },
  username: string,
  tweetId: string,
): Promise<void> {
  // Resolve @mention provider handle to URL, or fall back to direct URL.
  const providerHandle = intent.provider_handle?.toLowerCase().trim() ?? null;
  const provider = providerHandle ? (PROVIDER_HANDLES[providerHandle] ?? null) : null;

  const url = provider ? provider.url : (intent.x402_url?.trim() ?? null);
  if (!url || !url.startsWith("https://")) {
    const supported = Object.keys(PROVIDER_HANDLES).join(", ");
    await postThread(
      `@${username} Provide a URL or a supported provider (${supported}). Example: @gitbankbot x402-pay @ExaAILabs "DeFi protocols" 0.01 USDC`,
      tweetId,
    );
    return;
  }

  const maxAmount = intent.amount ?? null;
  if (!maxAmount || maxAmount <= 0) {
    await postThread(`@${username} Specify the max amount you approve. Example: @gitbankbot x402-pay ${url} 0.01 USDC`, tweetId);
    return;
  }

  const symbol = (intent.token_in ?? "USDC").toUpperCase();
  const token  = resolveToken(symbol === "ETH" ? "WETH" : symbol);
  if (!token) {
    await postThread(`@${username} x402-pay only supports USDC.`, tweetId);
    return;
  }

  let paymentOpt;
  try {
    paymentOpt = await fetchX402Requirements(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postThread(`@${username} Could not reach the URL: ${msg}`, tweetId);
    return;
  }

  if (!paymentOpt) {
    await postThread(`@${username} That URL did not return an x402 payment challenge (HTTP 402 + PAYMENT-REQUIRED header).`, tweetId);
    return;
  }

  if (!paymentOpt.network?.includes("8453")) {
    await postThread(`@${username} Payment rejected: API requires network ${paymentOpt.network}. GitVault only supports Base (eip155:8453).`, tweetId);
    return;
  }

  if (paymentOpt.asset && isAddress(paymentOpt.asset)) {
    if (paymentOpt.asset.toLowerCase() !== token.address.toLowerCase()) {
      await postThread(`@${username} Payment rejected: API requires token ${paymentOpt.asset} but you specified ${token.symbol}.`, tweetId);
      return;
    }
  }

  const requiredAtomic    = BigInt(paymentOpt.maxAmountRequired);
  const maxApprovedAtomic = toTokenUnits(maxAmount, token.decimals);
  if (requiredAtomic > maxApprovedAtomic) {
    const requiredDisplay = x402AtomicToHuman(paymentOpt.maxAmountRequired, token.decimals);
    await postThread(`@${username} Payment rejected: API requires ${requiredDisplay} ${token.symbol} but you approved max ${maxAmount}. Try: @gitbankbot x402-pay ${url} ${requiredDisplay} USDC`, tweetId);
    return;
  }

  const payTo = paymentOpt.payTo;
  if (!payTo || !isAddress(payTo)) {
    await postThread(`@${username} Payment rejected: API returned invalid payTo address.`, tweetId);
    return;
  }

  // Step 1: Unshield from vault to deployer EOA (intermediate payer).
  const grossUnshield   = computeUnshieldGrossForNet(requiredAtomic);
  const vault           = xUser.vaultAddress as Address;
  const xId             = BigInt(xUser.xUserId);
  const vaultNonce      = await readVaultNonce(vault);
  const deployerAddress = getDeployerAddress();

  const result = await callVault(xUser.encryptedPk, vault, xId, "gitUnshield", [
    token.address, grossUnshield, deployerAddress, vaultNonce,
  ]);

  // Step 2: Wait for unshield confirmation on-chain before signing EIP-3009.
  try {
    await waitForTxConfirmation(result.txHash, 60_000);
  } catch {
    await postThread(`@${username} Unshield tx submitted but confirmation timed out. Tx: ${result.txHash}`, tweetId);
    return;
  }

  // Step 3: Sign EIP-3009 TransferWithAuthorization from deployer.
  const paymentPayload = await signEip3009Authorization(paymentOpt, requiredAtomic);

  // If a named provider was used, override retryBody with the user's search query.
  const providerRetryBody = provider ? provider.buildBody(intent.search_query?.trim() ?? "") : null;
  const finalRetryBody = providerRetryBody ?? paymentOpt.retryBody;

  // Step 4: Retry URL with X-PAYMENT header (same method as probe, with body if POST).
  let apiResp: { status: number; body: string } = { status: 0, body: "" };
  try {
    apiResp = await sendX402Request(url, paymentPayload, paymentOpt.probeMethod, finalRetryBody);
  } catch {
    // Non-fatal — payment was already sent.
  }

  await db.insert(transactionsTable).values({
    type:     "unlock",
    githubId:  Number(xId),
    tokenOut:  token.address,
    amountOut: requiredAtomic.toString(),
    txHash:    result.txHash,
    status:    "pending",
  });

  // Step 5: Store API response
  const paidAmount  = x402AtomicToHuman(paymentOpt.maxAmountRequired, token.decimals);
  const amountDisplay = `${paidAmount} ${token.symbol}`;

  const insertResult = await db.insert(x402ResultsTable).values({
    url,
    amountDisplay,
    txHash:         result.txHash,
    payTo,
    payer:          deployerAddress,
    senderLogin:    username,
    responseStatus: apiResp.status,
    responseBody:   apiResp.body,
  }).returning({ id: x402ResultsTable.id }).catch(() => []);

  const resultId = insertResult[0]?.id ?? null;

  // Step 6: Post single combined reply
  const statusNote = apiResp.status === 200 ? "API: 200 OK" : apiResp.status > 0 ? `API: ${apiResp.status}` : "API: no response";
  const tweetSummary = extractTweetSummary(apiResp.body);
  const parts: string[] = [`Paid ${amountDisplay} via x402 | ${statusNote}`];
  if (tweetSummary) parts.push(tweetSummary);
  if (resultId) parts.push(`Full data: https://gitbank.io/x402/result/${resultId}`);
  await postThread(`@${username} ` + parts.join("\n\n"), tweetId);
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

export async function handleMention(
  tweetId:          string,
  text:             string,
  xUserId:          string,
  xUsername:        string,
  authorCreatedAt:  string,
  parentTweet?:     { text: string; authorUsername: string } | null,
  mediaUrl?:        string | null,
  parentMediaUrl?:  string | null,
  parentAuthorPfp?: string | null,
): Promise<void> {
  // Phase 4: account age guard
  if (isTooNew(authorCreatedAt)) {
    logger.info({ xUserId, xUsername }, "x-bot: skipping new account");
    return;
  }

  const cleanText = text.replace(/@gitbankbot/gi, "").trim();
  const intent    = await parseXIntent(cleanText, parentTweet);

  // Vault commands always route to their handler, even with low confidence.
  // Low confidence on a vault keyword = missing params → handler sends correct usage.
  // Only genuinely non-command intents go to QA.
  const VAULT_INTENTS = ["deposit","withdraw","swap","transfer","balance","launch","help","x402_pay"];
  const isVaultCommand = VAULT_INTENTS.includes(intent.intent);

  if (!isVaultCommand && (intent.intent === "qa" || intent.intent === "unknown" || intent.confidence < 0.6)) {
    await handleQA(cleanText, xUsername, tweetId, parentTweet);
    return;
  }

  if (intent.intent === "help") {
    await postThread(
      `@${xUsername} Gitbank commands:\n` +
      `deposit <amount> <token>\n` +
      `withdraw <amount> <token> to <0xAddress>\n` +
      `swap <amount> <token> to <token>\n` +
      `send <amount> <token> to @user\n` +
      `balance\n` +
      `launch <Token Name> $TICKER (attach logo image)\n\n` +
      `Tokens: USDC, WETH. All on Base Mainnet.`,
      tweetId,
    );
    return;
  }

  // Phase 4: rate limit
  if (!checkRateLimit(xUserId)) {
    await postThread(`@${xUsername} Rate limit reached. Max 10 commands per hour.`, tweetId);
    return;
  }

  // Pre-flight: validate params BEFORE deploying vault.
  if (intent.intent === "deposit") {
    const rawSym = (intent.token_in ?? "").toUpperCase().trim();
    const sym    = rawSym === "ETH" ? "WETH" : rawSym;
    const t      = sym ? resolveToken(sym) : null;
    if (!t || !intent.amount || intent.amount <= 0) {
      await postThread(`@${xUsername} Example: @gitbankbot deposit 10 USDC`, tweetId);
      return;
    }
  }

  if (intent.intent === "withdraw") {
    const t = resolveToken((intent.token_in ?? "") === "ETH" ? "WETH" : (intent.token_in ?? ""));
    if (!t || !intent.amount || intent.amount <= 0) {
      await postThread(`@${xUsername} Example: @gitbankbot withdraw 10 USDC to 0xYourAddress`, tweetId);
      return;
    }
    if (!intent.recipient || !isAddress(intent.recipient)) {
      await postThread(`@${xUsername} Include destination address. Example: @gitbankbot withdraw ${intent.amount} ${t.symbol} to 0xYourAddress`, tweetId);
      return;
    }
  }

  if (intent.intent === "swap") {
    const tIn  = resolveToken((intent.token_in ?? "") === "ETH" ? "WETH" : (intent.token_in ?? ""));
    const tOut = resolveToken((intent.token_out ?? "") === "ETH" ? "WETH" : (intent.token_out ?? ""));
    if (!tIn || !tOut) {
      await postThread(`@${xUsername} Specify token pair. Example: @gitbankbot swap 10 USDC to WETH`, tweetId);
      return;
    }
    if (!intent.amount || intent.amount <= 0) {
      await postThread(`@${xUsername} Specify amount. Example: @gitbankbot swap 10 ${tIn.symbol} to ${tOut.symbol}`, tweetId);
      return;
    }
  }

  if (intent.intent === "transfer") {
    const t = resolveToken((intent.token_in ?? "") === "ETH" ? "WETH" : (intent.token_in ?? ""));
    if (!t || !intent.amount || intent.amount <= 0) {
      await postThread(`@${xUsername} Example: @gitbankbot send 10 USDC to @alice`, tweetId);
      return;
    }
    if (!intent.recipient || !(intent.recipient as string).replace("@", "")) {
      await postThread(`@${xUsername} Specify recipient. Example: @gitbankbot send ${intent.amount} ${t.symbol} to @alice`, tweetId);
      return;
    }
  }

  if (intent.intent === "launch") {
    if (!intent.token_name?.trim() || !intent.token_symbol?.trim()) {
      await postThread(`@${xUsername} Include token name and ticker. Example: @gitbankbot launch My Token $MTK`, tweetId);
      return;
    }
  }

  // All params valid — get or deploy vault now
  const xUser = await getOrDeployXVault(xUserId, xUsername);
  if (!xUser) {
    await postThread(`@${xUsername} Vault deployment failed. Try again in 30 seconds.`, tweetId);
    return;
  }

  try {
    switch (intent.intent) {
      case "deposit":   await handleDeposit(intent, xUser, xUsername, tweetId);          break;
      case "withdraw":  await handleWithdraw(intent, xUser, xUsername, tweetId);         break;
      case "swap":      await handleSwap(intent, xUser, xUsername, tweetId);             break;
      case "transfer":  await handleTransfer(intent, xUser, xUsername, tweetId);         break;
      case "balance":   await handleBalance(xUser, xUsername, tweetId);                  break;
      case "launch":    await handleLaunch(intent, xUser, xUsername, tweetId, mediaUrl, parentMediaUrl, parentAuthorPfp); break;
      case "x402_pay":  await handleX402Pay(intent, xUser, xUsername, tweetId);          break;
      default:
        await handleQA(cleanText, xUsername, tweetId, parentTweet);
    }
  } catch (err) {
    logger.error({ err, intent: intent.intent, xUserId }, "x-bot command error");
    await postThread(`@${xUsername} Something went wrong. Please try again.`, tweetId);
  }
}

// ── Shitpost generator ────────────────────────────────────────────────────────

const SHITPOST_SYSTEM = `You are @gitbankbot. Generate a single short X post (tweet) about Gitbank.
Teach something real about the project: how it works, what was just shipped, why the architecture is interesting.
Rules:
- Under 250 characters
- English only
- No hashtags, no em dash, no emojis
- No price, no trading volume, no market data ever
- No fluff. Direct. Technical. Confident.
- Never mention Replit or team members`;

export async function generateShitpost(): Promise<string> {
  const data = await fetchLiveData();
  const topics = [
    `Focus on IssueOps model: all vault commands run via @gitbankbot mentions in GitHub Issues and PRs. No UI needed to move funds or assign bounties. ${data.vaultCount} vaults live.`,
    `Focus on soul-bound vaults: GitTokens are non-transferable ERC-20. No transfer, no approve. Cannot be phished or drained via approval exploit. Anchored to GitHub permanent user ID.`,
    `Focus on relayer pattern: users pay zero gas. Deployer submits all transactions. Execution keypairs encrypted AES-256-GCM server-side. ${data.txCount} on-chain transactions so far.`,
    `Focus on 2-step transfer: initTransfer (hash commitment) then finalizeTransfer (signature). Prevents front-running on inter-vault sends.`,
    `Focus on PR merge auto-payout: when a PR merges, @gitbankbot detects the event, reads the assigned bounty, and executes the payout on-chain. No human intervention.`,
    `Focus on AutoGit: describe an app in plain English, AI generates the React component, @gitbankbot creates the repo and deploys to GitHub Pages. From prompt to live URL with zero git commands.`,
    `Focus on project budget management: @gitbankbot create project locks budget on-chain. assign task deducts from budget. cancel task triggers reclaimBounty. All state is on Base L2.`,
    `Focus on x402 integration: Gitbank vaults can pay x402-protected API endpoints. HTTP 402 with payment details, vault signs and settles on-chain, request proceeds. ${data.vaultCount} vaults ready.`,
    `Focus on EIP-1167 minimal proxy clones: GitVaultFactory deploys per-user vaults cheaply via clone pattern. One implementation, unlimited vaults. Factory live on Base Mainnet.`,
    `Focus on GitHub permanent user ID as identity anchor: immutable integer, cannot be spoofed via username rename. Used as vault key in smart contracts. ${data.vaultCount} vaults indexed this way.`,
  ];
  const topic = topics[Math.floor(Math.random() * topics.length)]!;

  try {
    const msg = await anthropic.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 128,
      system:     SHITPOST_SYSTEM,
      messages:   [{ role: "user", content: `Topic: ${topic}` }],
    });
    return msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
  } catch (err) {
    logger.error({ err }, "generateShitpost error");
    return "";
  }
}
