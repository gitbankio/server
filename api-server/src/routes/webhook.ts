import { Router, type Request } from "express";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { db, usersTable, tasksTable, projectsTable, commandLogTable, transactionsTable, pendingDepositsTable, installationsTable, launchedTokensTable, x402ResultsTable, mcpPendingTable, holderTokenRewardsTable, rwaPositions, gitStockContracts } from "@workspace/db";
import { isValidTicker, getAsset, getLivePrice, listTickers, getAllKnownPrices } from "@workspace/rwa";
import { getOrCreateSolanaWallet } from "@workspace/solana-relayer";
import { buyStock as jupiterBuyStock, sellStock as jupiterSellStock, quoteUsdcToStock, quoteStockToUsdc, MarketClosedError, isMarketOpen, nextMarketOpenStr } from "@workspace/jupiter";
import { bridgeToSolana, bridgeToBase } from "@workspace/cctp";
import { eq, and, desc } from "drizzle-orm";
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
  buyTokenWithEthFromDeployer,
  getPoolInfoFromDeployReceipt,
  sendErc20FromDeployer,
  batchAirdropFromDeployer,
} from "../lib/relayer";
import { postTweet } from "../lib/x-client";
import { generateKeypair, encryptPrivateKey } from "../lib/key-engine";
import { getInstallationToken } from "../lib/github-app";
import { resolveToken, getAllTokens } from "../lib/tokens";
import { buildSendCallsPayload } from "../lib/send-calls";
import { keccak256, encodePacked, isAddress, type Address, createPublicClient, createWalletClient, http, fallback, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { Clanker } from "clanker-sdk/v4";

const router = Router();

const WEBHOOK_SECRET = process.env["GITHUB_WEBHOOK_SECRET"] ?? "";
const DEX_ROUTER = process.env["DEX_ROUTER_ADDRESS"] ?? "";
const EXPLORER = process.env["BASE_NETWORK"] === "mainnet"
  ? "https://basescan.org/tx"
  : "https://sepolia.basescan.org/tx";
const EXPLORER_ADDR = process.env["BASE_NETWORK"] === "mainnet"
  ? "https://basescan.org/address"
  : "https://sepolia.basescan.org/address";
const NETWORK_LABEL = process.env["BASE_NETWORK"] === "mainnet" ? "Base Mainnet" : "Base Sepolia";

const anthropic = new Anthropic({
  apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] ?? "",
  baseURL: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"] ?? undefined,
});

// ── Rate limiter: 10 commands per 60 minutes per GitHub ID ────────────────────
const rateLimiter = new Map<number, { count: number; resetAt: number }>();

function checkRateLimit(githubId: number): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(githubId);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(githubId, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

function verifySignature(body: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── NLP intent parser ─────────────────────────────────────────────────────────

const INTENT_SYSTEM_PROMPT = `You are the Gitbank intent parser. Extract structured intent from a GitHub issue comment.

The comment is from a user who has tagged @gitbankbot. Extract their intent and return ONLY valid JSON.

Supported intents:
Personal vault: deposit, withdraw, swap, transfer, balance_check, claim, history, help, cancel
Project workspace: create_project, assign_bounty, project_status, cancel_task, rebalance_budget
Token launch: launch_token
x402 payments: x402_pay
RWA stocks: buy_stock, sell_stock, rwa_portfolio
Other: unknown

Return JSON with this exact shape:
{
  "intent": "<intent string>",
  "token_in": "<USDC|WETH|ETH|null>",
  "token_out": "<USDC|WETH|ETH|null>",
  "amount": <number or null>,
  "recipient": "<@username or 0xaddress or null>",
  "project_name": "<string or null>",
  "issue_id": <number or null>,
  "contributor": "<@username or null>",
  "confidence": <0.0 to 1.0>,
  "language": "<ISO 639-1 code of the comment language, e.g. en, id, zh, es, de, fr, ja, it, pt, ko>",
  "token_name": "<full token name or null>",
  "token_symbol": "<ticker symbol, uppercase, max 10 chars, or null>",
  "token_description": "<description string or null>",
  "token_link": "<website or repo URL or null>",
  "token_x": "<X/Twitter profile URL (x.com or twitter.com) or null>",
  "token_logo": "<direct image URL for logo or null>",
  "x402_url": "<full https:// URL for x402-pay command or null>"
}

Notes:
- ETH and WETH both map to token_in/token_out = "WETH"
- For "swap 0.01 ETH to USDC": token_in="WETH", token_out="USDC", amount=0.01
- For "deposit 50 USDC": intent="deposit", token_in="USDC", amount=50
- For "send 20 USDC to @alice": intent="transfer", token_in="USDC", amount=20, recipient="@alice"
- For "withdraw 50 USDC to 0x1234...": intent="withdraw", token_in="USDC", amount=50, recipient="0x1234..."
- For withdraw, recipient is always a 0x wallet address (hex). If no address given, set recipient=null.
- For "cancel", "cancel deposit", "nevermind", "stop", "abort": intent="cancel", all other fields null.
- "cancel" cancels a pending deposit poller. "cancel_task" cancels a project bounty task -- they are different.
- For "launch token", "deploy token", "create token": intent="launch_token". Extract token_name, token_symbol, token_description, token_link, token_x, token_logo from the comment.
- For "claim", "claim fees", "claim rewards", "collect fees": intent="claim", all other fields null.
- For token_link: the main website/project URL (non-X/Twitter link). Keywords: "link", "website", "web", "site".
- For token_x: any X.com or Twitter.com URL in the comment. Keywords: "x", "twitter", "tweet".
- For token_logo: extract from explicit logo/image URL in the comment, OR from GitHub image attachments (markdown like ![image](https://user-images.githubusercontent.com/...) or any image URL ending in .png .jpg .gif .webp). Use the first image found if multiple exist.
- Detect the language of the comment and set the language field. Default to "en" if unclear.
- For "x402-pay", "pay via x402", "pay this API", "pay URL": intent="x402_pay". Extract the https:// URL into x402_url, amount into amount, and token (usually USDC) into token_in.
  Example: "@gitbankbot x402-pay https://api.example.com/data 0.01 USDC" -> intent="x402_pay", x402_url="https://api.example.com/data", amount=0.01, token_in="USDC"
- For "buy stock", "buy NVDA", "buy AAPL", "invest in ...", "buy 100 USDC of TSLA": intent="buy_stock". Extract the stock ticker into ticker, and USDC spend amount into amount, token_in="USDC".
  Example: "@gitbankbot buy NVDA 100 USDC" -> intent="buy_stock", ticker="NVDA", token_in="USDC", amount=100
- For "sell stock", "sell gitNVDA", "sell NVDA", "sell 1.5 AAPL": intent="sell_stock". Extract the ticker into ticker, and the stock amount into amount.
  Example: "@gitbankbot sell NVDA 1" -> intent="sell_stock", ticker="NVDA", amount=1
- For "rwa portfolio", "my stocks", "stock portfolio", "gitstock balance", "what stocks do I own": intent="rwa_portfolio". No extra fields needed.

Return ONLY the JSON object. No explanation, no markdown.`;

interface ParsedIntent {
  intent: string;
  token_in: string | null;
  token_out: string | null;
  amount: number | null;
  recipient: string | null;
  project_name: string | null;
  issue_id: number | null;
  contributor: string | null;
  confidence: number;
  language: string;
  token_name?: string | null;
  token_symbol?: string | null;
  token_description?: string | null;
  token_link?: string | null;
  token_x?: string | null;
  token_logo?: string | null;
  x402_url?: string | null;
  ticker?: string | null;
}

async function parseIntent(commentText: string, issueTitle: string): Promise<ParsedIntent> {
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system: INTENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Issue title: ${issueTitle}\nComment: ${commentText}` }],
  });

  const raw  = message.content[0]?.type === "text" ? message.content[0].text : "{}";
  // Strip markdown code fences Claude sometimes wraps around the JSON
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(text) as ParsedIntent;
  } catch {
    return {
      intent: "unknown", token_in: null, token_out: null, amount: null,
      recipient: null, project_name: null, issue_id: null, contributor: null, confidence: 0,
      language: "en",
    };
  }
}

// ── Discussion comment context (module-level, safe for sequential async flow) ──
// Set before handling a discussion_comment event, cleared after. Mirrors _webhookLang pattern.
let _discussionNodeId: string | null = null;
// Node ID of a TOP-LEVEL discussion comment — used as replyToId so bot replies are threaded.
// Always a top-level comment node_id; if triggering comment is a reply we resolve its parent first.
let _discussionReplyToId: string | null = null;

/**
 * Given the numeric database ID of a discussion comment, return its GraphQL node_id.
 * Queries up to 100 top-level comments of the discussion and finds the matching one.
 */
async function resolveDiscussionCommentNodeId(
  token: string,
  owner: string,
  repo: string,
  discussionNumber: number,
  commentDatabaseId: number,
): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "Gitbank",
      },
      body: JSON.stringify({
        query: `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){comments(first:100){nodes{id databaseId}}}}}`,
        variables: { owner, repo, number: discussionNumber },
      }),
    });
    const data = await res.json() as { data?: { repository?: { discussion?: { comments?: { nodes?: { id: string; databaseId: number }[] } } } } };
    const nodes = data?.data?.repository?.discussion?.comments?.nodes ?? [];
    return nodes.find(n => n.databaseId === commentDatabaseId)?.id ?? null;
  } catch {
    return null;
  }
}

// ── Localization helper ───────────────────────────────────────────────────────

async function localize(text: string, lang: string): Promise<string> {
  if (!lang || lang === "en") return text;
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2048,
      system: `Translate the non-code portions of this GitHub bot reply to the language with ISO 639-1 code "${lang}". Rules:
- Keep exactly as-is: @mentions, 0x... wallet addresses, inline code (backtick spans), triple-backtick code blocks, URLs, numbers
- Translate: all other human-readable text (sentences, labels, descriptions, error messages)
- Never use the em dash character (--) in output
- Return only the translated text, no preamble or explanation`,
      messages: [{ role: "user", content: text }],
    });
    return msg.content[0]?.type === "text" ? msg.content[0].text : text;
  } catch {
    return text;
  }
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

// Per-request language context. Set by dispatcher before handling each command.
// Node.js is single-threaded; concurrent webhook events each await their own
// async chain, so this is safe for the sequential command-per-comment flow.
let _webhookLang = "en";

async function _postRaw(
  repo: string,
  issueNumber: number,
  body: string,
  installationId: number,
): Promise<string | null> {
  // Only post real GitHub comments in production — dev server must never spam GitHub
  if (process.env["NODE_ENV"] !== "production") {
    logger.info({ repo, issueNumber, body: body.slice(0, 120) }, "[DEV] would post GitHub comment (skipped)");
    return null;
  }

  let token: string;
  try {
    token = await getInstallationToken(installationId);
  } catch {
    return null;
  }

  // Discussion comments require GraphQL addDiscussionComment (REST does not support them)
  if (_discussionNodeId) {
    const postDiscussionComment = async (replyToId: string | null): Promise<string | null> => {
      const variables: Record<string, string> = { id: _discussionNodeId!, body };
      if (replyToId) variables["replyToId"] = replyToId;
      const mutation = replyToId
        ? `mutation($id:ID!,$body:String!,$replyToId:ID!){addDiscussionComment(input:{discussionId:$id,body:$body,replyToId:$replyToId}){comment{id}}}`
        : `mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){comment{id}}}`;
      const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Gitbank",
        },
        body: JSON.stringify({ query: mutation, variables }),
      });
      const data = await res.json() as { errors?: unknown[]; data?: { addDiscussionComment?: { comment?: { id?: string } } } };
      if (data.errors?.length) return null; // signal failure
      return data?.data?.addDiscussionComment?.comment?.id ?? null;
    };

    if (_discussionReplyToId) {
      // Try as threaded reply first; fall back to top-level if replyToId is itself a reply
      const id = await postDiscussionComment(_discussionReplyToId);
      if (id !== null) return id;
    }
    return postDiscussionComment(null);
  }

  const [owner, repoName] = repo.split("/");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Gitbank",
    },
    body: JSON.stringify({ body }),
  });
  const data = await res.json() as { id?: number };
  return data?.id ? String(data.id) : null;
}

async function updateGitHubComment(
  commentId: string,
  repo: string,
  text: string,
  installationId: number,
): Promise<void> {
  if (process.env["NODE_ENV"] !== "production") return;
  let token: string;
  try {
    token = await getInstallationToken(installationId);
  } catch {
    return;
  }
  const body = await localize(text, _webhookLang);
  // Discussion comment: use GraphQL updateDiscussionComment
  if (_discussionNodeId) {
    await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "Gitbank",
      },
      body: JSON.stringify({
        query: `mutation($id:ID!,$body:String!){updateDiscussionComment(input:{commentId:$id,body:$body}){comment{id}}}`,
        variables: { id: commentId, body },
      }),
    });
    return;
  }
  // Issue/PR comment: use REST PATCH
  const [owner, repoName] = repo.split("/");
  await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/comments/${commentId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Gitbank",
    },
    body: JSON.stringify({ body }),
  });
}

async function postGitHubComment(
  repo: string,
  issueNumber: number,
  text: string,
  installationId: number,
): Promise<string | null> {
  const body = await localize(text, _webhookLang);
  return _postRaw(repo, issueNumber, body, installationId);
}

function receipt(
  operation: string,
  txHash: string,
  extra: string[] = [],
): string {
  const lines = [
    "```",
    "Gitbank Receipt",
    "-".repeat(48),
    `Operation  : ${operation}`,
    `Tx Hash    : ${txHash}`,
    `Network    : ${NETWORK_LABEL}`,
    `Gas        : Covered by Gitbank Relayer`,
    ...extra,
    "-".repeat(48),
    "```",
    `[View on Basescan](${EXPLORER}/${txHash})`,
  ];
  return lines.join("\n");
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleDeposit(
  intent: ParsedIntent,
  user: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
): Promise<void> {
  const rawSymbol = intent.token_in ?? "";
  const isNativeEth = rawSymbol.toUpperCase() === "ETH";
  const symbol = isNativeEth ? "WETH" : rawSymbol;

  const token = resolveToken(symbol);
  if (!token) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Unknown token "${rawSymbol}". Supported: WETH, USDC.`, installationId);
    return;
  }
  if (!intent.amount || intent.amount <= 0) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify a positive amount. Example: \`@gitbankbot deposit 50 USDC\``, installationId);
    return;
  }

  const vault = user.vaultAddress as Address;
  const amountWei = toTokenUnits(intent.amount, token.decimals);

  // Check how many tokens have already arrived at the vault address
  let available = 0n;
  try {
    available = await readVaultAvailableDeposit(vault, token.address);
  } catch {
    available = 0n;
  }

  if (available < amountWei) {
    const needed = intent.amount;
    const have = (Number(available) / 10 ** token.decimals).toFixed(token.decimals === 6 ? 2 : 6);
    const stillNeeded = ((Number(amountWei - available)) / 10 ** token.decimals).toFixed(token.decimals === 6 ? 2 : 6);
    const ethNote = isNativeEth
      ? `\n> **Note:** Native ETH is not supported. You need **WETH** (Wrapped ETH). Wrap at [app.uniswap.org](https://app.uniswap.org) or any Base DEX first.`
      : "";

    // Post instruction comment first so we can save its ID for later update
    const instructionCommentId = await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Send **${stillNeeded} ${token.symbol}** to your vault on Base and Gitbank will lock it automatically:\n\n` +
      "```\n" +
      `${vault}\n` +
      "```\n" +
      `[View vault on Basescan](${EXPLORER_ADDR}/${vault})\n\n` +
      "```\n" +
      `Token        : ${token.symbol} (${NETWORK_LABEL})\n` +
      `Amount       : ${needed} ${token.symbol}\n` +
      `Already here : ${have} ${token.symbol}\n` +
      `Still needed : ${stillNeeded} ${token.symbol}\n` +
      "```\n\n" +
      `Gitbank watches for the deposit and locks it within ~30 seconds. This request expires in 24 hours.${ethNote}`,
      installationId);

    // Register a pending deposit -- poller will auto-lock once tokens arrive at vault
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await db.insert(pendingDepositsTable).values({
      githubId: user.githubId,
      trackingAddress: vault,
      token: token.address,
      tokenSymbol: token.symbol,
      amountExpected: amountWei.toString(),
      issueNumber,
      repo,
      installationId,
      senderLogin,
      commentId: instructionCommentId,
      expiresAt,
    }).onConflictDoUpdate({
      target: [pendingDepositsTable.trackingAddress, pendingDepositsTable.token],
      set: {
        token: token.address,
        tokenSymbol: token.symbol,
        amountExpected: amountWei.toString(),
        issueNumber,
        repo,
        installationId,
        senderLogin,
        commentId: instructionCommentId,
        expiresAt,
      },
    });
    return;
  }

  // Tokens already in vault -- lock immediately
  const nonce = await readVaultNonce(vault);
  const result = await lockDeposit(user.encryptedPk, vault, BigInt(user.githubId), token.address, amountWei, nonce);

  await db.insert(transactionsTable).values({
    type: "lock",
    githubId: user.githubId,
    tokenIn: token.address,
    amountIn: amountWei.toString(),
    txHash: result.txHash,
    status: "pending",
  });

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Deposit submitted.\n\n` +
    receipt("deposit", result.txHash, [`Token      : ${intent.amount} ${token.symbol}`]),
    installationId,
  );
}

async function handleWithdraw(
  intent: ParsedIntent,
  user: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
): Promise<void> {
  const symbol = intent.token_in ?? "";
  const token = resolveToken(symbol === "ETH" ? "WETH" : symbol);
  if (!token) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Unknown token "${symbol}". Supported: USDC, WETH.`, installationId);
    return;
  }
  if (!intent.amount || intent.amount <= 0) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify a positive amount. Example:\n\`@gitbankbot withdraw 50 USDC to 0xYourWalletAddress\``, installationId);
    return;
  }

  // Destination wallet address is required -- tokens go to an external wallet, not back to vault owner.
  const destination = intent.recipient ?? null;
  if (!destination || !isAddress(destination)) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify the destination wallet address. Example:\n\`@gitbankbot withdraw ${intent.amount} ${token.symbol} to 0xYourWalletAddress\`\n\nTokens will be sent to that address on Base L2.`,
      installationId);
    return;
  }

  const amountWei = toTokenUnits(intent.amount, token.decimals);
  const vault = user.vaultAddress as Address;
  const nonce = await readVaultNonce(vault);

  // gitUnshield: burns gitTokens, sends net tokens directly to destination (0.10% fee on-chain).
  // Destination is bound in ownerSig -- cannot be redirected by any attacker.
  const unlockResult = await callVault(
    user.encryptedPk, vault, BigInt(user.githubId),
    "gitUnshield",
    [token.address, amountWei, destination as Address, nonce],
  );

  await db.insert(transactionsTable).values({
    type: "unlock",
    githubId: user.githubId,
    tokenOut: token.address,
    amountOut: amountWei.toString(),
    txHash: unlockResult.txHash,
    status: "pending",
  });

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Withdrawal submitted.\n\n` +
    receipt("withdraw", unlockResult.txHash, [
      `Token      : ${intent.amount} ${token.symbol}`,
      `Net amount : ${(intent.amount * 0.999).toFixed(token.decimals === 6 ? 2 : 6)} ${token.symbol} (after 0.10% fee)`,
      `Destination: ${destination}`,
    ]),
    installationId,
  );
}

async function handleSwap(
  intent: ParsedIntent,
  user: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
): Promise<void> {
  if (!DEX_ROUTER) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Swap is not available right now (router not configured). Please try again later.`,
      installationId);
    return;
  }

  const inSymbol = intent.token_in ?? "";
  const outSymbol = intent.token_out ?? "";
  const tokenIn = resolveToken(inSymbol === "ETH" ? "WETH" : inSymbol);
  const tokenOut = resolveToken(outSymbol === "ETH" ? "WETH" : outSymbol);

  if (!tokenIn || !tokenOut) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Unknown token pair "${inSymbol}" -> "${outSymbol}". Supported: USDC, WETH.`,
      installationId);
    return;
  }
  if (!tokenOut.swapOutputAllowed) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} "${outSymbol}" is not an allowed swap output. Allowed: USDC, WETH.`,
      installationId);
    return;
  }
  if (!intent.amount || intent.amount <= 0) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify a positive amount. Example: \`@gitbankbot swap 0.01 WETH to USDC\``,
      installationId);
    return;
  }

  const vault = user.vaultAddress as Address;
  const amountWei = toTokenUnits(intent.amount, tokenIn.decimals);
  // Router gets the net amount (after 0.30% protocol fee) — mirrors GitVault._collectFee
  const netSwapAmount = computeSwapNetAmount(amountWei);
  const { routerAddress, routerData } = await buildSwapRouterData(
    tokenIn.address, tokenOut.address, netSwapAmount, vault,
  );
  const nonce = await readVaultNonce(vault);

  const result = await callVault(user.encryptedPk, vault, BigInt(user.githubId), "gitSwap", [
    tokenIn.address, tokenOut.address, amountWei, 0n,
    routerAddress, routerData, nonce,
  ]);

  await db.insert(transactionsTable).values({
    type: "swap",
    githubId: user.githubId,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn: amountWei.toString(),
    txHash: result.txHash,
    status: "pending",
  });

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Swap submitted.\n\n` +
    receipt("swap", result.txHash, [
      `From       : ${intent.amount} ${tokenIn.symbol}`,
      `To         : ${tokenOut.symbol}`,
    ]),
    installationId,
  );
}

async function handleTransfer(
  intent: ParsedIntent,
  user: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
): Promise<void> {
  const symbol = intent.token_in ?? "";
  const token = resolveToken(symbol === "ETH" ? "WETH" : symbol);
  if (!token) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Unknown token "${symbol}". Supported: USDC, WETH.`, installationId);
    return;
  }
  if (!intent.amount || intent.amount <= 0) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify a positive amount. Example: \`@gitbankbot send 20 USDC to @alice\``,
      installationId);
    return;
  }

  const recipientLogin = (intent.recipient ?? "").replace("@", "");
  if (!recipientLogin) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify a recipient. Example: \`@gitbankbot send 20 USDC to @alice\``,
      installationId);
    return;
  }

  const recipientRows = await db.select().from(usersTable)
    .where(eq(usersTable.githubLogin, recipientLogin)).limit(1);
  let recipientVault = recipientRows[0]?.vaultAddress ?? null;
  let recipientGithubId: number = recipientRows[0]?.githubId ?? 0;

  // Auto-deploy vault for recipient if they don't have one yet
  if (!recipientVault) {
    // Look up their GitHub ID via the API
    try {
      const ghToken = await getInstallationToken(installationId);
      const ghRes = await fetch(`https://api.github.com/users/${recipientLogin}`, {
        headers: { Authorization: `Bearer ${ghToken}`, "User-Agent": "Gitbank" },
      });
      if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
      const ghUser = await ghRes.json() as { id: number; login: string };
      recipientGithubId = ghUser.id;
    } catch {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} Could not find GitHub user @${recipientLogin}. Please check the username.`,
        installationId);
      return;
    }

    // Notify sender we are setting up the vault
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} @${recipientLogin} does not have a vault yet. Deploying one now - this takes about 10 seconds.`,
      installationId);

    // Upsert the recipient user record
    const existingRecipient = await db.select().from(usersTable)
      .where(eq(usersTable.githubId, recipientGithubId)).limit(1);

    if (!existingRecipient[0]) {
      await db.insert(usersTable).values({
        githubId: recipientGithubId,
        githubLogin: recipientLogin,
        role: "member",
      });
    }

    // Generate keypair + deploy vault (deployer pays all gas)
    const kp = generateKeypair();
    const encPk = encryptPrivateKey(kp.privateKey);
    await db.update(usersTable)
      .set({ ownerAddress: kp.address, encryptedPk: encPk })
      .where(eq(usersTable.githubId, recipientGithubId));

    try {
      await deployVault(encPk, BigInt(recipientGithubId), kp.address as Address);
    } catch (err) {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} Vault deployment for @${recipientLogin} failed. Please try again in a moment.`,
        installationId);
      return;
    }

    // Poll until vault address resolves on-chain (Base ~2s blocks, max ~40s)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const addr = await getVaultByGithubId(BigInt(recipientGithubId));
        if (addr && addr !== "0x0000000000000000000000000000000000000000") {
          recipientVault = addr;
          await db.update(usersTable)
            .set({ vaultAddress: addr })
            .where(eq(usersTable.githubId, recipientGithubId));
          break;
        }
      } catch { /* keep polling */ }
    }

    if (!recipientVault) {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} @${recipientLogin} vault is taking longer than expected to confirm. Please try the transfer again in 30 seconds.`,
        installationId);
      return;
    }
  }

  const vault = user.vaultAddress as Address;
  const to = recipientVault as Address;
  const amountWei = toTokenUnits(intent.amount, token.decimals);

  const initNonce = await readVaultNonce(vault);
  const initHash = keccak256(encodePacked(
    ["uint256", "address", "address", "uint256"],
    [initNonce, token.address, to, amountWei],
  ));

  await callVault(user.encryptedPk, vault, BigInt(user.githubId), "initTransfer", [initHash]);

  // Wait for initTransfer to be mined (~2s blocks on Base)
  let finalNonce = initNonce;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    finalNonce = await readVaultNonce(vault);
    if (finalNonce > initNonce) break;
  }

  const result = await callVault(user.encryptedPk, vault, BigInt(user.githubId), "finalizeTransfer", [
    token.address, to, amountWei, finalNonce, initNonce,
  ]);

  await db.insert(transactionsTable).values({
    type: "transfer",
    githubId: user.githubId,
    tokenOut: token.address,
    amountOut: amountWei.toString(),
    txHash: result.txHash,
    status: "pending",
  });

  // Auto-shield recipient tokens: insert pending_deposits so poller calls gitShield within ~15s
  if (recipientGithubId && recipientVault) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insert(pendingDepositsTable).values({
      githubId: recipientGithubId,
      trackingAddress: recipientVault,
      token: token.address,
      tokenSymbol: token.symbol,
      amountExpected: amountWei.toString(),
      issueNumber,
      repo,
      installationId,
      senderLogin: recipientLogin,
      expiresAt,
    }).onConflictDoUpdate({
      target: [pendingDepositsTable.trackingAddress, pendingDepositsTable.token],
      set: {
        token: token.address,
        tokenSymbol: token.symbol,
        amountExpected: amountWei.toString(),
        issueNumber,
        repo,
        installationId,
        senderLogin: recipientLogin,
        expiresAt,
      },
    });
  }

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Transfer submitted.\n\n` +
    receipt("transfer", result.txHash, [
      `Amount     : ${intent.amount} ${token.symbol}`,
      `To         : @${recipientLogin}`,
    ]) +
    `\n\n@${recipientLogin} You received **${intent.amount} ${token.symbol}** from @${senderLogin}.\n` +
    `Tokens will be locked into your vault automatically within 30 seconds. Run \`@gitbankbot balance\` to confirm.`,
    installationId,
  );
}


// ── Main issue_comment handler ────────────────────────────────────────────────

// ── Project command handlers ───────────────────────────────────────────────────

async function handleCreateProject(
  intent: ParsedIntent,
  user: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
): Promise<void> {
  if (!intent.project_name) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify a project name. Example: \`@gitbankbot create project 'Sprint 1' with 500 USDC budget\``,
      installationId);
    return;
  }
  const symbol = (intent.token_in ?? "USDC").replace("ETH", "WETH");
  const token = resolveToken(symbol);
  if (!token) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Unknown token "${symbol}". Supported: USDC, WETH.`, installationId);
    return;
  }
  if (!intent.amount || intent.amount <= 0) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify a budget amount. Example: \`@gitbankbot create project 'Sprint 1' with 500 USDC budget\``,
      installationId);
    return;
  }

  const amountWei = toTokenUnits(intent.amount, token.decimals);
  const vault = user.vaultAddress as Address;

  const inserted = await db.insert(projectsTable).values({
    onchainProjectId: Date.now(),
    ownerGithubId: user.githubId,
    repo,
    name: intent.project_name,
    token: token.symbol,
    totalBudget: amountWei.toString(),
    spentBudget: "0",
    status: "active",
  }).returning();

  const project = inserted[0]!;
  const onchainProjectId = BigInt(project.id);
  const nonce = await readVaultNonce(vault);
  const result = await callVault(user.encryptedPk, vault, BigInt(user.githubId), "createProject", [
    onchainProjectId, token.address, amountWei, nonce,
  ]);

  await db.update(projectsTable)
    .set({ onchainProjectId: project.id, txHash: result.txHash })
    .where(eq(projectsTable.id, project.id));

  await db.insert(transactionsTable).values({
    type: "project_create",
    githubId: user.githubId,
    amountIn: amountWei.toString(),
    tokenIn: token.address,
    txHash: result.txHash,
    status: "pending",
    projectDbId: project.id,
  });

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Project created.\n\n` +
    receipt("create_project", result.txHash, [
      `Project    : ${intent.project_name}`,
      `Budget     : ${intent.amount} ${token.symbol}`,
      `Repo       : ${repo}`,
    ]),
    installationId);
}

async function handleAssignBounty(
  intent: ParsedIntent,
  user: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
): Promise<void> {
  if (!intent.contributor) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please tag a contributor. Example: \`@gitbankbot assign this task to @alice with 80 USDC bounty\``,
      installationId);
    return;
  }
  if (!intent.amount || intent.amount <= 0) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify a bounty amount. Example: \`@gitbankbot assign this task to @alice with 80 USDC bounty\``,
      installationId);
    return;
  }

  const contributorLogin = intent.contributor.replace(/^@/, "");

  // Look up contributor in our DB
  const contribRows = await db.select().from(usersTable)
    .where(eq(usersTable.githubLogin, contributorLogin)).limit(1);
  const contributor = contribRows[0];
  if (!contributor?.vaultAddress) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} @${contributorLogin} does not have a deployed Gitbank vault yet. Ask them to visit https://gitbank.io/app/onboarding`,
      installationId);
    return;
  }

  // Find active project in this repo (most recent active project owned by sender)
  const projectRows = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.repo, repo), eq(projectsTable.ownerGithubId, user.githubId), eq(projectsTable.status, "active")))
    .limit(1);
  const project = projectRows[0];
  if (!project) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} No active project found in this repo. Create one first with \`@gitbankbot create project 'Name' with 500 USDC budget\``,
      installationId);
    return;
  }

  const symbol = (intent.token_in ?? project.token ?? "USDC").replace("ETH", "WETH");
  const token = resolveToken(symbol);
  if (!token) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Unknown token "${symbol}". Supported: USDC, WETH.`, installationId);
    return;
  }

  const amountWei = toTokenUnits(intent.amount, token.decimals);
  const vault = user.vaultAddress as Address;
  const nonce = await readVaultNonce(vault);
  const result = await callVault(user.encryptedPk, vault, BigInt(user.githubId), "assignTaskBounty", [
    BigInt(project.onchainProjectId),
    BigInt(issueNumber),
    contributor.vaultAddress as Address,
    amountWei,
    nonce,
  ]);

  const inserted = await db.insert(tasksTable).values({
    issueNumber,
    repo,
    projectDbId: project.id,
    contributorGithubId: contributor.githubId,
    bountyAmount: amountWei.toString(),
    token: token.symbol,
    status: "assigned",
    assignTxHash: result.txHash,
  }).returning();

  const task = inserted[0]!;

  await db.insert(transactionsTable).values({
    type: "bounty_assign",
    githubId: user.githubId,
    amountIn: amountWei.toString(),
    tokenIn: token.address,
    txHash: result.txHash,
    status: "pending",
    projectDbId: project.id,
    taskDbId: task.id,
  });

  // Update project spent budget
  const newSpent = (parseFloat(project.spentBudget) + intent.amount).toString();
  await db.update(projectsTable).set({ spentBudget: newSpent }).where(eq(projectsTable.id, project.id));

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Bounty assigned.\n\n` +
    receipt("assign_bounty", result.txHash, [
      `Contributor : @${contributorLogin}`,
      `Bounty     : ${intent.amount} ${token.symbol}`,
      `Project    : ${project.name}`,
      `Issue      : #${issueNumber}`,
    ]),
    installationId);
}

async function handleCancelTask(
  user: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
): Promise<void> {
  const taskRows = await db.select().from(tasksTable)
    .where(and(
      eq(tasksTable.issueNumber, issueNumber),
      eq(tasksTable.repo, repo),
      eq(tasksTable.status, "assigned"),
    )).limit(1);

  const task = taskRows[0];
  if (!task) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} No active bounty task found for issue #${issueNumber}.`,
      installationId);
    return;
  }

  const vault = user.vaultAddress as Address;
  const nonce = await readVaultNonce(vault);
  const result = await callVault(user.encryptedPk, vault, BigInt(user.githubId), "reclaimBounty", [
    BigInt(issueNumber), nonce,
  ]);

  await db.update(tasksTable).set({ status: "cancelled" }).where(eq(tasksTable.id, task.id));

  await db.insert(transactionsTable).values({
    type: "bounty_reclaim",
    githubId: user.githubId,
    amountOut: task.bountyAmount,
    tokenOut: task.token,
    txHash: result.txHash,
    status: "pending",
    projectDbId: task.projectDbId,
    taskDbId: task.id,
  });

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Task cancelled and bounty reclaimed.\n\n` +
    receipt("cancel_task", result.txHash, [
      `Issue      : #${issueNumber}`,
      `Reclaimed  : ${task.bountyAmount} ${task.token}`,
    ]),
    installationId);
}

async function handleProjectStatus(
  intent: ParsedIntent,
  user: { githubId: number },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
): Promise<void> {
  const projectRows = await db.select().from(projectsTable)
    .where(and(
      eq(projectsTable.repo, repo),
      eq(projectsTable.ownerGithubId, user.githubId),
      eq(projectsTable.status, "active"),
    )).limit(1);

  const project = intent.project_name
    ? (await db.select().from(projectsTable)
        .where(and(eq(projectsTable.repo, repo), eq(projectsTable.name, intent.project_name)))
        .limit(1))[0] ?? projectRows[0]
    : projectRows[0];

  if (!project) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} No active project found in this repo.`,
      installationId);
    return;
  }

  const tasks = await db.select().from(tasksTable).where(eq(tasksTable.projectDbId, project.id));
  const assigned = tasks.filter((t) => t.status === "assigned").length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const cancelled = tasks.filter((t) => t.status === "cancelled").length;

  const totalBudget = parseFloat(project.totalBudget) / 10 ** (project.token === "USDC" ? 6 : 18);
  const spentBudget = parseFloat(project.spentBudget) / 10 ** (project.token === "USDC" ? 6 : 18);
  const pct = totalBudget > 0 ? Math.round((spentBudget / totalBudget) * 100) : 0;

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} **Project: ${project.name}**\n\n` +
    "```\n" +
    `Status     : ${project.status}\n` +
    `Budget     : ${spentBudget.toFixed(2)} / ${totalBudget.toFixed(2)} ${project.token} (${pct}% used)\n` +
    `Tasks      : ${assigned} active | ${completed} completed | ${cancelled} cancelled\n` +
    `Dashboard  : https://gitbank.io/app/projects/${project.id}\n` +
    "```",
    installationId);
}

// ── x402 response formatter ───────────────────────────────────────────────────
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

// ── x402_pay handler ──────────────────────────────────────────────────────────

async function handleX402Pay(
  intent: ParsedIntent,
  user: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
): Promise<void> {
  const url = intent.x402_url?.trim() ?? null;
  if (!url || !url.startsWith("https://")) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please provide a valid https:// URL. Example:\n` +
      `\`@gitbankbot x402-pay https://api.example.com/data 0.01 USDC\``,
      installationId);
    return;
  }

  const maxAmount = intent.amount ?? null;
  if (!maxAmount || maxAmount <= 0) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify the maximum amount you approve. Example:\n` +
      `\`@gitbankbot x402-pay ${url} 0.01 USDC\``,
      installationId);
    return;
  }

  const symbol = (intent.token_in ?? "USDC").toUpperCase();
  const token = resolveToken(symbol === "ETH" ? "WETH" : symbol);
  if (!token) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} x402-pay only supports USDC. Example:\n` +
      `\`@gitbankbot x402-pay ${url} 0.01 USDC\``,
      installationId);
    return;
  }

  // 1. Probe URL for x402 payment requirements
  let paymentOpt;
  try {
    paymentOpt = await fetchX402Requirements(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Could not reach the URL: ${msg}`,
      installationId);
    return;
  }

  if (!paymentOpt) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} That URL did not return an x402 payment challenge (HTTP 402 with PAYMENT-REQUIRED header).\n\n` +
      `The API at \`${url}\` may not support x402. Ask the developer to add \`@x402/express\` middleware.`,
      installationId);
    return;
  }

  // 2. Verify network is Base
  if (!paymentOpt.network?.includes("8453")) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Payment rejected: the API requires payment on network \`${paymentOpt.network}\`, ` +
      `but GitVault only supports Base (eip155:8453).`,
      installationId);
    return;
  }

  // 2b. Verify the asset address returned by the API matches the token the user specified.
  // Prevents incorrect payment if the server advertises a different token than expected.
  if (paymentOpt.asset && isAddress(paymentOpt.asset)) {
    const assetLower = paymentOpt.asset.toLowerCase();
    if (assetLower !== token.address.toLowerCase()) {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} Payment rejected: the API requires payment in token \`${paymentOpt.asset}\`, ` +
        `but you specified **${token.symbol}** (\`${token.address}\`). ` +
        `Specify the correct token in your command.`,
        installationId);
      return;
    }
  }

  // 3. Verify requested amount <= user-approved max.
  // All comparisons done in bigint atomic units to avoid floating-point precision loss
  // for large amounts. x402AtomicToHuman() is used only for human-readable display.
  const requiredAtomic = BigInt(paymentOpt.maxAmountRequired);
  const maxApprovedAtomic = toTokenUnits(maxAmount, token.decimals);
  if (requiredAtomic > maxApprovedAtomic) {
    const requiredDisplay = x402AtomicToHuman(paymentOpt.maxAmountRequired, token.decimals);
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Payment rejected: the API requires **${requiredDisplay} ${token.symbol}** ` +
      `but you approved a maximum of **${maxAmount} ${token.symbol}**.\n\n` +
      `To approve: \`@gitbankbot x402-pay ${url} ${requiredDisplay} USDC\``,
      installationId);
    return;
  }

  // 4. Validate payTo address
  const payTo = paymentOpt.payTo;
  if (!payTo || !isAddress(payTo)) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Payment rejected: the API returned an invalid payTo address (\`${payTo}\`).`,
      installationId);
    return;
  }

  // 5. Unshield from vault to deployer EOA (intermediate payer).
  //    The deployer is an EOA with a private key and can sign EIP-3009 natively.
  //    After unshield confirms, deployer signs a TransferWithAuthorization and
  //    retries the request with the X-PAYMENT header so the API server can settle
  //    via the x402 facilitator (Coinbase CDP).
  //
  //    Gross amount: vault deducts MINIMUM_FEE (0.1 USDC) before sending net to
  //    the deployer. We compute gross so deployer receives exactly requiredAtomic.
  const grossUnshield = computeUnshieldGrossForNet(requiredAtomic);
  const vault = user.vaultAddress as Address;
  const vaultNonce = await readVaultNonce(vault);
  const deployerAddress = getDeployerAddress();

  const unlockResult = await callVault(
    user.encryptedPk, vault, BigInt(user.githubId),
    "gitUnshield",
    [token.address, grossUnshield, deployerAddress, vaultNonce],
  );

  // 6. Wait for unshield tx to be included in a block.
  //    Deployer must hold the USDC before the EIP-3009 signature can settle.
  try {
    await waitForTxConfirmation(unlockResult.txHash, 60_000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Unshield tx submitted but confirmation timed out: ${msg}\n\nTx: ${EXPLORER}/${unlockResult.txHash}`,
      installationId);
    return;
  }

  // 7. Sign EIP-3009 TransferWithAuthorization from deployer to API payTo.
  //    Amount is the NET required by the API (not the gross we unshielded).
  const paymentPayload = await signEip3009Authorization(paymentOpt, requiredAtomic);

  // 8. Retry the original URL with the X-PAYMENT header (using same method as probe).
  let apiResponse: { status: number; body: string; paymentResponse?: string };
  try {
    apiResponse = await sendX402Request(url, paymentPayload, paymentOpt.probeMethod, paymentOpt.retryBody);
    logger.info({ url, status: apiResponse.status, bodySnippet: apiResponse.body.slice(0, 400) }, "x402: third-party API response");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Unshield confirmed but the API call failed: ${msg}\n\nUnshield Tx: ${EXPLORER}/${unlockResult.txHash}`,
      installationId);
    return;
  }

  // 9. Record transaction
  await db.insert(transactionsTable).values({
    type: "unlock",
    githubId: user.githubId,
    tokenOut: token.address,
    amountOut: grossUnshield.toString(),
    txHash: unlockResult.txHash,
    status: "pending",
  });

  // 10. Store API response to DB, format with AI, post receipt + summary + link
  const amountDisplay = `${x402AtomicToHuman(paymentOpt.maxAmountRequired, token.decimals)} ${token.symbol}`;
  const description = paymentOpt.description ? `\nService    : ${paymentOpt.description}` : "";
  const apiStatusLabel = apiResponse.status === 200
    ? "200 OK (payment accepted)"
    : `${apiResponse.status} (check API response)`;

  // Run DB insert and AI formatting in parallel
  const [insertResult, formattedSummary] = await Promise.allSettled([
    db.insert(x402ResultsTable).values({
      url,
      amountDisplay,
      txHash: unlockResult.txHash,
      payTo,
      payer: deployerAddress,
      senderLogin,
      responseStatus: apiResponse.status,
      responseBody: apiResponse.body,
    }).returning({ id: x402ResultsTable.id }),
    formatX402Response(url, apiResponse.body, apiResponse.status),
  ]);

  const resultId = insertResult.status === "fulfilled" ? insertResult.value[0]?.id : null;
  if (insertResult.status === "rejected") {
    logger.warn({ err: insertResult.reason }, "x402: failed to store result");
  }

  const summaryText = formattedSummary.status === "fulfilled" ? formattedSummary.value : "";
  const summarySection = summaryText ? `\n\n**API Response Summary:**\n\n${summaryText}` : "";
  const fullDataLink = resultId
    ? `\n\n[View full JSON response](https://gitbank.io/x402/result/${resultId})`
    : "";

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} x402 payment sent via EIP-3009.\n\n` +
    "```\n" +
    "Gitbank x402 Receipt\n" +
    "-".repeat(48) + "\n" +
    `URL        : ${url}` + "\n" +
    `Amount     : ${amountDisplay}` + "\n" +
    `Payer      : ${deployerAddress} (Gitbank Relayer)` + "\n" +
    `Recipient  : ${payTo}` + "\n" +
    `Network    : ${NETWORK_LABEL}` + "\n" +
    `Unshield Tx: ${unlockResult.txHash}` +
    description + "\n" +
    `Gas        : Covered by Gitbank Relayer\n` +
    `API Status : ${apiStatusLabel}\n` +
    "-".repeat(48) + "\n" +
    "```\n" +
    `[View Unshield on Basescan](${EXPLORER}/${unlockResult.txHash})` +
    summarySection +
    fullDataLink,
    installationId,
  );
}

// ── launch_token fee config ────────────────────────────────────────────────────
// LP trading fees split between creator and Gitbank platform via Clanker SDK rewards.
// Uses basis points (bps) — total must equal 10000.
const LAUNCH_TOKEN_DEV_WALLET = "0x1e660A9A1f1F08AFEF9c03c96D66260122464CF2" as `0x${string}`;
const LAUNCH_TOKEN_DEV_BPS = 2000;                          // 20% LP fees to dev wallet
const LAUNCH_TOKEN_CREATOR_BPS = 10000 - LAUNCH_TOKEN_DEV_BPS; // 80% to creator
const MCP_LAUNCH_ETH_WEI = 10_000_000_000_000_000n; // 0.01 ETH
const GITBANK_CA = "0xC21dd0eE043930711C2a3e55F39C7d3144d09B07";

// ── MCP launch helpers ────────────────────────────────────────────────────────

function getAlchemyRpcUrl(): string {
  return process.env["BASE_RPC_URL"] ?? process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org";
}

interface AlchemyTransfer {
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  rawContract: { value: string | null; address: string | null; decimal: string | null };
  metadata?: { blockTimestamp?: string } | null;
}

async function alchemyGetAssetTransfers(params: Record<string, unknown>): Promise<{ transfers: AlchemyTransfer[]; pageKey?: string }> {
  const rpc = getAlchemyRpcUrl();
  const resp = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "alchemy_getAssetTransfers", params: [params] }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json() as { result?: { transfers: AlchemyTransfer[]; pageKey?: string }; error?: unknown };
  if (data.error) throw new Error(`alchemy_getAssetTransfers error: ${JSON.stringify(data.error)}`);
  return data.result ?? { transfers: [] };
}

async function verifyEthDepositViaBasescan(
  fromAddress: string,
  toAddress: string,
  minAmountWei: bigint,
  withinMs = 30 * 60 * 1000,
): Promise<{ verified: boolean; txHash: string | null }> {
  try {
    const cutoffMs = Date.now() - withinMs;
    let pageKey: string | undefined;
    do {
      const result = await alchemyGetAssetTransfers({
        toAddress,
        category: ["external"],
        maxCount: "0x64",
        withMetadata: true,
        excludeZeroValue: true,
        order: "desc",
        ...(pageKey ? { pageKey } : {}),
      });
      for (const tx of result.transfers) {
        const tsMs = tx.metadata?.blockTimestamp ? new Date(tx.metadata.blockTimestamp).getTime() : Date.now();
        if (tsMs < cutoffMs) return { verified: false, txHash: null };
        const valueWei = tx.value != null ? BigInt(Math.round(tx.value * 1e18)) : 0n;
        if (
          tx.from.toLowerCase() === fromAddress.toLowerCase() &&
          tx.to?.toLowerCase() === toAddress.toLowerCase() &&
          valueWei >= minAmountWei
        ) {
          return { verified: true, txHash: tx.hash };
        }
      }
      pageKey = result.pageKey;
    } while (pageKey);
  } catch (err) {
    logger.warn({ err }, "verifyEthDeposit: alchemy fetch failed");
  }
  return { verified: false, txHash: null };
}

// Addresses that hold GITBANK tokens but are NOT real holders.
// Sending reward tokens to these = tokens lost or unclaimable.
const GITBANK_HOLDER_EXCLUDE = new Set([
  "0x0000000000000000000000000000000000000000", // zero / mint source
  "0x000000000000000000000000000000000000dead", // burn address
  "0x498581ff718922c3f8e6a244956af099b2652b2b", // Uniswap V4 PoolManager — holds all LP liquidity (~12% of supply)
  "0x63d2dfea64b3433f4071a98665bcd7ca14d93496", // Uniswap V4 PositionManager
  "0xe85a59c628f7d27878aceb4bf3b35733630083a9", // Clanker v4 factory
  "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc", // Clanker v4 hooks
  "0x7c5f5a4bbd8fd63184577525326123b519429bdc", // Clanker periphery
  "0x000000000022d473030f116ddee9f6b43ac78ba3", // Permit2
  "0x1e660a9a1f1f08afef9c03c96d66260122464cf2", // Gitbank deployer / relayer treasury
]);

async function getGitbankHolders(): Promise<Array<{ address: string; balance: bigint }>> {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const MAX_PAGES = 50; // 50 × 1000 = 50k transfers max; avoids multi-minute hangs
  const balances = new Map<string, bigint>();
  let pageKey: string | undefined;
  let page = 0;
  try {
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
      }
      pageKey = result.pageKey;
      page++;
      if (page >= MAX_PAGES) {
        logger.warn({ page, hasMorePages: !!pageKey }, "getGitbankHolders: hit page limit — partial holder list");
        break;
      }
    } while (pageKey);
  } catch (err) {
    logger.warn({ err }, "getGitbankHolders: alchemy fetch failed");
  }
  return Array.from(balances.entries())
    .filter(([addr, bal]) => bal > 0n && !GITBANK_HOLDER_EXCLUDE.has(addr))
    .map(([address, balance]) => ({ address, balance }));
}

async function distributeNewTokenToHolders(
  newTokenAddress: Address,
  totalTokens: bigint,
  holders: Array<{ address: string; balance: bigint }>,
  launchId: number,
): Promise<number> {
  if (holders.length === 0 || totalTokens === 0n) return 0;
  const totalGitbank = holders.reduce((sum, h) => sum + h.balance, 0n);

  // Build recipient + amount arrays (skip dust shares)
  const recipients: Address[] = [];
  const amounts: bigint[] = [];
  for (const holder of holders) {
    const share = (totalTokens * holder.balance) / totalGitbank;
    if (share === 0n) continue;
    recipients.push(holder.address as Address);
    amounts.push(share);
  }
  if (recipients.length === 0) return 0;

  // Batch airdrop via GitbankAirdrop contract (approve + batchTransfer chunks)
  const { count, txHashes } = await batchAirdropFromDeployer(newTokenAddress as Address, recipients, amounts);

  // Record each recipient in holderTokenRewardsTable, attributing the first
  // batchTransfer tx hash (index 1; index 0 is the approve tx).
  const batchTxHash = txHashes[1] ?? txHashes[0] ?? "";
  for (let i = 0; i < recipients.length; i++) {
    await db.insert(holderTokenRewardsTable).values({
      launchId,
      holderAddress: recipients[i]!,
      tokenCa: newTokenAddress,
      amountWei: amounts[i]!.toString(),
      txHash: batchTxHash,
    });
  }

  return count;
}

// ── gitStock ERC-20 mint/burn helpers ────────────────────────────────────────

const GIT_STOCK_FACTORY_ABI = parseAbi([
  "function deployStock(string calldata ticker, string calldata name, string calldata symbol) external returns (address token)",
  "function getStock(string calldata ticker) external view returns (address)",
]);

const GIT_STOCK_TOKEN_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function burn(address from, uint256 amount) external",
]);

function getRwaChain() {
  const isMainnet = process.env["BASE_NETWORK"] === "mainnet";
  return {
    chain: isMainnet ? base : baseSepolia,
    rpcUrl: isMainnet
      ? (process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org")
      : (process.env["BASE_RPC_URL"] ?? process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org"),
  };
}

/**
 * Get token address for a ticker, deploying via GitStockFactory if needed.
 * Returns null if GIT_STOCK_FACTORY_ADDRESS or DEPLOYER_PRIVATE_KEY is unset.
 */
async function getOrDeployGitStockToken(
  ticker: string,
  assetName: string,
): Promise<`0x${string}` | null> {
  const factoryAddress = process.env["GIT_STOCK_FACTORY_ADDRESS"] as `0x${string}` | undefined;
  if (!factoryAddress) return null;

  // Fast path: check DB cache
  const dbRow = await db.select({ contractAddress: gitStockContracts.contractAddress })
    .from(gitStockContracts).where(eq(gitStockContracts.ticker, ticker)).limit(1);
  if (dbRow[0]) return dbRow[0].contractAddress as `0x${string}`;

  const { chain, rpcUrl } = getRwaChain();
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  // Check on-chain
  const onChainAddr = await publicClient.readContract({
    address: factoryAddress,
    abi: GIT_STOCK_FACTORY_ABI,
    functionName: "getStock",
    args: [ticker],
  }) as `0x${string}`;

  const ZERO = "0x0000000000000000000000000000000000000000";
  if (onChainAddr !== ZERO) {
    await db.insert(gitStockContracts).values({
      ticker,
      name: `Gitbank ${assetName}`,
      symbol: `git${ticker}`,
      contractAddress: onChainAddr,
      chainId: process.env["BASE_NETWORK"] === "mainnet" ? 8453 : 84532,
    }).onConflictDoNothing();
    return onChainAddr;
  }

  // Deploy new — requires DEPLOYER_PRIVATE_KEY (onlyDeployer on factory)
  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as `0x${string}` | undefined;
  if (!deployerPk) return null;

  const deployer = privateKeyToAccount(deployerPk);
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });

  const deployTxHash = await walletClient.writeContract({
    address: factoryAddress,
    abi: GIT_STOCK_FACTORY_ABI,
    functionName: "deployStock",
    args: [ticker, `Gitbank ${assetName}`, `git${ticker}`],
  });
  await publicClient.waitForTransactionReceipt({ hash: deployTxHash });

  const newAddr = await publicClient.readContract({
    address: factoryAddress,
    abi: GIT_STOCK_FACTORY_ABI,
    functionName: "getStock",
    args: [ticker],
  }) as `0x${string}`;

  await db.insert(gitStockContracts).values({
    ticker,
    name: `Gitbank ${assetName}`,
    symbol: `git${ticker}`,
    contractAddress: newAddr,
    deployTxHash,
    chainId: process.env["BASE_NETWORK"] === "mainnet" ? 8453 : 84532,
  }).onConflictDoNothing();

  return newAddr;
}

/**
 * Mint soul-bound gitStock ERC-20 to user's Base EOA via RELAYER_SIGNING_KEY.
 * Returns tx hash on success, null if factory address not configured.
 */
async function mintGitStockOnBase(
  ticker: string,
  assetName: string,
  ownerAddress: `0x${string}`,
  amount: bigint,
): Promise<string | null> {
  const relayerPk = process.env["RELAYER_SIGNING_KEY"] as `0x${string}` | undefined;
  if (!relayerPk) return null;

  const tokenAddress = await getOrDeployGitStockToken(ticker, assetName);
  if (!tokenAddress) return null;

  const { chain, rpcUrl } = getRwaChain();
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const relayer = privateKeyToAccount(relayerPk);
  const walletClient = createWalletClient({ account: relayer, chain, transport: http(rpcUrl) });

  const txHash = await walletClient.writeContract({
    address: tokenAddress,
    abi: GIT_STOCK_TOKEN_ABI,
    functionName: "mint",
    args: [ownerAddress, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/**
 * Burn soul-bound gitStock ERC-20 from user's Base EOA via RELAYER_SIGNING_KEY.
 * Returns tx hash on success, null if factory/token not found.
 */
async function burnGitStockOnBase(
  ticker: string,
  ownerAddress: `0x${string}`,
  amount: bigint,
): Promise<string | null> {
  const relayerPk = process.env["RELAYER_SIGNING_KEY"] as `0x${string}` | undefined;
  if (!relayerPk) return null;

  const factoryAddress = process.env["GIT_STOCK_FACTORY_ADDRESS"] as `0x${string}` | undefined;
  if (!factoryAddress) return null;

  const { chain, rpcUrl } = getRwaChain();
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  // Look up token address from DB or on-chain
  const dbRow = await db.select({ contractAddress: gitStockContracts.contractAddress })
    .from(gitStockContracts).where(eq(gitStockContracts.ticker, ticker)).limit(1);

  let tokenAddress: `0x${string}`;
  if (dbRow[0]) {
    tokenAddress = dbRow[0].contractAddress as `0x${string}`;
  } else {
    const onChainAddr = await publicClient.readContract({
      address: factoryAddress,
      abi: GIT_STOCK_FACTORY_ABI,
      functionName: "getStock",
      args: [ticker],
    }) as `0x${string}`;
    if (onChainAddr === "0x0000000000000000000000000000000000000000") return null;
    tokenAddress = onChainAddr;
  }

  const relayer = privateKeyToAccount(relayerPk);
  const walletClient = createWalletClient({ account: relayer, chain, transport: http(rpcUrl) });

  const txHash = await walletClient.writeContract({
    address: tokenAddress,
    abi: GIT_STOCK_TOKEN_ABI,
    functionName: "burn",
    args: [ownerAddress, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

// ── RWA handlers ──────────────────────────────────────────────────────────────

async function handleBuyStock(
  intent: ParsedIntent,
  vaultUser: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string, issueNumber: number, senderLogin: string, installationId: number,
): Promise<void> {
  const ticker = (intent.ticker ?? "").toUpperCase();
  if (!ticker || !isValidTicker(ticker)) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Unknown stock ticker "${ticker}". Available: NVDA, AAPL, TSLA, META, MSFT, GOOGL, AMZN, SPY, QQQ`,
      installationId);
    return;
  }

  const usdcAmount = intent.amount;
  if (!usdcAmount || usdcAmount <= 0) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please specify a USDC amount. Example: \`@gitbankbot buy NVDA 100 USDC\``,
      installationId);
    return;
  }

  const githubIdStr = String(vaultUser.githubId);
  const asset = getAsset(ticker);

  // Fail fast: Ondo GM tokens only trade 24/5 — check before bridging USDC
  if (!isMarketOpen()) {
    const openStr = nextMarketOpenStr();
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} **Ondo GM market is currently closed.**\n\n` +
      `${openStr}\n\n` +
      `> Note: Ondo GM tokens (gitSPCX, gitTSLA, etc.) follow US equity market hours and trade ` +
      `Sunday 8 PM ET through Friday 8 PM ET. Your order will not be processed while the market is closed.`,
      installationId);
    return;
  }

  // Notify user that the multi-step process has started (~1-3 min)
  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Processing your git${ticker} purchase (${usdcAmount} USDC)...\n\n` +
    `Step 1/4: Setting up Solana custody wallet`,
    installationId);

  // 1. Get or create Solana custody wallet for this user
  const { publicKey: solanaWalletPubkey, keypair } = await getOrCreateSolanaWallet(githubIdStr);

  // 2. Bridge USDC from Base to Solana (CCTP V2)
  // Deployer wallet (DEPLOYER_PRIVATE_KEY) holds the USDC on Base and pays bridge gas.
  const usdcAmountUnits = BigInt(Math.round(usdcAmount * 1_000_000)); // 6 decimals
  const bridgePk = (process.env["DEPLOYER_PRIVATE_KEY"] as string);

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Step 2/4: Bridging ${usdcAmount} USDC from Base to Solana via CCTP (this takes ~1-2 min)...`,
    installationId);

  const bridgeResult = await bridgeToSolana({
    amount: usdcAmountUnits,
    destSolanaPublicKey: solanaWalletPubkey,
    relayerPrivateKey: bridgePk,
  });

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Step 3/4: Buying ${ticker} on Ondo order-engine (Solana)...`,
    installationId);

  // 3. Buy Ondo stock via Jupiter RFQ → Ondo JIT mint + fill (Solana)
  const swapResult = await jupiterBuyStock(
    asset.mintAddress,
    usdcAmountUnits,
    keypair,
  );

  // 4. Upsert rwa_positions in DB
  const existing = await db.select().from(rwaPositions)
    .where(and(eq(rwaPositions.githubId, githubIdStr), eq(rwaPositions.ticker, ticker)))
    .limit(1);

  const gitStockRow = await db.select().from(gitStockContracts)
    .where(eq(gitStockContracts.ticker, ticker)).limit(1);
  const gitStockContract = gitStockRow[0]?.contractAddress ?? "";

  if (existing[0]) {
    const prevAmount = BigInt(existing[0].amount);
    const prevCost = BigInt(existing[0].costBasisUsdc);
    await db.update(rwaPositions).set({
      amount: (prevAmount + swapResult.amountReceived).toString(),
      costBasisUsdc: (prevCost + usdcAmountUnits).toString(),
      buyTxSolana: swapResult.txHash,
      buyTxBase: bridgeResult.sourceTxHash,
      updatedAt: new Date(),
    }).where(and(eq(rwaPositions.githubId, githubIdStr), eq(rwaPositions.ticker, ticker)));
  } else {
    await db.insert(rwaPositions).values({
      githubId: githubIdStr,
      ticker,
      ondaMintAddress: asset.mintAddress,
      gitStockContract,
      amount: swapResult.amountReceived.toString(),
      costBasisUsdc: usdcAmountUnits.toString(),
      solanaWalletPubkey,
      buyTxSolana: swapResult.txHash,
      buyTxBase: bridgeResult.sourceTxHash,
    });
  }

  // 5. Mint soul-bound gitStock ERC-20 receipt on Base
  const buyerRow = await db.select({ ownerAddress: usersTable.ownerAddress })
    .from(usersTable).where(eq(usersTable.githubId, vaultUser.githubId)).limit(1);
  const buyerAddr = buyerRow[0]?.ownerAddress as `0x${string}` | undefined;
  let mintTxHash: string | null = null;
  if (buyerAddr) {
    try {
      mintTxHash = await mintGitStockOnBase(ticker, asset.name, buyerAddr, swapResult.amountReceived);
    } catch (mintErr) {
      // Non-fatal: DB position is recorded; ERC-20 can be minted retroactively
      console.warn("[gitStock] mint failed:", (mintErr as Error).message);
    }
  }

  const priceUsd = await getLivePrice(ticker).catch(() => 0);
  const stockAmount = Number(swapResult.amountReceived) / 1_000_000_000;

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Stock purchase complete!\n\n` +
    `**Bought:** ${stockAmount.toFixed(6)} git${ticker} (${asset.name})\n` +
    `**Spent:** ${usdcAmount} USDC\n` +
    `**Live Price:** $${priceUsd.toFixed(2)}\n` +
    `**Bridge Tx (Base):** \`${bridgeResult.sourceTxHash}\`\n` +
    `**Swap Tx (Solana):** \`${swapResult.txHash}\`\n` +
    (mintTxHash ? `**Mint Tx (Base):** \`${mintTxHash}\`\n` : "") +
    `**Solana Custody Wallet:** \`${solanaWalletPubkey}\`\n\n` +
    `Your git${ticker} position is now active. View portfolio: \`@gitbankbot rwa portfolio\``,
    installationId);
}

async function handleSellStock(
  intent: ParsedIntent,
  vaultUser: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string, issueNumber: number, senderLogin: string, installationId: number,
): Promise<void> {
  const ticker = (intent.ticker ?? "").toUpperCase();
  if (!ticker || !isValidTicker(ticker)) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Unknown stock ticker "${ticker}". Use \`@gitbankbot rwa portfolio\` to see your holdings.`,
      installationId);
    return;
  }

  const githubIdStr = String(vaultUser.githubId);

  const position = await db.select().from(rwaPositions)
    .where(and(eq(rwaPositions.githubId, githubIdStr), eq(rwaPositions.ticker, ticker)))
    .limit(1);

  if (!position[0] || BigInt(position[0].amount) === 0n) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} You have no git${ticker} holdings. Use \`@gitbankbot buy ${ticker} <USDC amount>\` to buy first.`,
      installationId);
    return;
  }

  const sellAmount = intent.amount
    ? BigInt(Math.round(intent.amount * 1_000_000_000))
    : BigInt(position[0].amount); // sell all if no amount given

  if (sellAmount > BigInt(position[0].amount)) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} You only hold ${(Number(BigInt(position[0].amount)) / 1_000_000_000).toFixed(6)} git${ticker}. Cannot sell ${(Number(sellAmount) / 1_000_000_000).toFixed(6)}.`,
      installationId);
    return;
  }

  const { keypair, publicKey: solanaWalletPubkey } = await getOrCreateSolanaWallet(githubIdStr);
  const asset = getAsset(ticker);
  const relayerPk = process.env["RELAYER_SIGNING_KEY"] as string;

  // Fail fast: check market hours before burning the receipt token (destructive)
  if (!isMarketOpen()) {
    const openStr = nextMarketOpenStr();
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} **Ondo GM market is currently closed.**\n\n` +
      `${openStr}\n\n` +
      `> Note: Ondo GM tokens (gitSPCX, gitTSLA, etc.) follow US equity market hours and trade ` +
      `Sunday 8 PM ET through Friday 8 PM ET. Your sell order has not been processed.`,
      installationId);
    return;
  }

  // Notify user that the multi-step process has started
  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Processing your git${ticker} sale...\n\n` +
    `Step 1/3: Burning git${ticker} receipt on Base`,
    installationId);

  // 0. Burn soul-bound gitStock ERC-20 receipt on Base before selling Ondo on Solana
  const sellerRow = await db.select({ ownerAddress: usersTable.ownerAddress })
    .from(usersTable).where(eq(usersTable.githubId, vaultUser.githubId)).limit(1);
  const sellerAddr = sellerRow[0]?.ownerAddress as `0x${string}` | undefined;
  let burnTxHash: string | null = null;
  if (sellerAddr) {
    try {
      burnTxHash = await burnGitStockOnBase(ticker, sellerAddr, sellAmount);
    } catch (burnErr) {
      // Non-fatal: worst case gitStock remains in wallet after sell; DB is source of truth
      console.warn("[gitStock] burn failed:", (burnErr as Error).message);
    }
  }

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Step 2/3: Selling ${ticker} on Ondo (Solana)...`,
    installationId);

  // 1. Sell Ondo stock → USDC via direct LP swap (Solana)
  // Compute minUsdcOut from cost basis pro-rated for sell amount, with 5% haircut
  const totalStock = BigInt(position[0].amount);
  const totalCostUsdc = BigInt(position[0].costBasisUsdc);
  const minUsdcOut = totalStock > 0n
    ? (sellAmount * totalCostUsdc * 95n) / (totalStock * 100n)
    : 1_000_000n; // fallback: 1 USDC minimum
  const swapResult = await jupiterSellStock(asset.mintAddress, sellAmount, keypair, minUsdcOut);

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Step 3/3: Bridging USDC from Solana back to your Base vault via CCTP (this takes ~1-2 min)...`,
    installationId);

  // 2. Bridge USDC from Solana back to Base vault (CCTP V2)
  const bridgeResult = await bridgeToBase({
    amount: swapResult.amountReceived,
    destBaseAddress: vaultUser.vaultAddress,
    solanaKeypair: keypair,
    relayerPrivateKey: relayerPk,
  });

  // 3. Update DB position
  const remaining = BigInt(position[0].amount) - sellAmount;
  if (remaining === 0n) {
    await db.delete(rwaPositions)
      .where(and(eq(rwaPositions.githubId, githubIdStr), eq(rwaPositions.ticker, ticker)));
  } else {
    const costRatio = Number(sellAmount) / Number(BigInt(position[0].amount));
    const reducedCost = BigInt(Math.round(Number(BigInt(position[0].costBasisUsdc)) * (1 - costRatio)));
    await db.update(rwaPositions).set({
      amount: remaining.toString(),
      costBasisUsdc: reducedCost.toString(),
      updatedAt: new Date(),
    }).where(and(eq(rwaPositions.githubId, githubIdStr), eq(rwaPositions.ticker, ticker)));
  }

  const usdcReceived = Number(swapResult.amountReceived) / 1_000_000;

  // 4. Write git_stock_sell transaction record so dashboard + E2E can track it
  try {
    await db.insert(transactionsTable).values({
      type: "git_stock_sell",
      githubId: vaultUser.githubId,
      tokenIn: `git${ticker}`,
      tokenOut: "USDC",
      amountIn: sellAmount.toString(),
      amountOut: swapResult.amountReceived.toString(),
      txHash: bridgeResult.destTxHash ?? bridgeResult.sourceTxHash ?? burnTxHash,
      status: "confirmed",
    });
  } catch {
    // Non-fatal: rwa_positions already updated
  }

  // 5. USDC is now in vault (CCTP minted directly to vaultAddress) — no gitShield needed.
  //    User can withdraw with: @gitbankbot withdraw X USDC to 0xAddress

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Stock sale complete!\n\n` +
    `**Sold:** ${(Number(sellAmount) / 1_000_000_000).toFixed(6)} git${ticker}\n` +
    `**Received:** ${usdcReceived.toFixed(2)} gitUSDC in your vault\n` +
    (burnTxHash ? `**Burn Tx (Base):** \`${burnTxHash}\`\n` : "") +
    `**Swap Tx (Solana):** \`${swapResult.txHash}\`\n` +
    `**Bridge Tx (Solana):** \`${bridgeResult.sourceTxHash}\`\n` +
    `**USDC to Vault (Base):** \`${bridgeResult.destTxHash}\`\n\n` +
    `Your gitUSDC is now in your Gitbank vault.\n` +
    `Withdraw: \`@gitbankbot withdraw ${usdcReceived.toFixed(2)} USDC to 0xYourAddress\``,
    installationId);
}

async function handleRwaPortfolio(
  vaultUser: { encryptedPk: string; vaultAddress: string; githubId: number },
  repo: string, issueNumber: number, senderLogin: string, installationId: number,
): Promise<void> {
  const githubIdStr = String(vaultUser.githubId);
  const positions = await db.select().from(rwaPositions)
    .where(eq(rwaPositions.githubId, githubIdStr));

  if (positions.length === 0) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} You have no gitStock holdings yet.\n\n` +
      `Buy your first stock: \`@gitbankbot buy NVDA 100 USDC\`\n` +
      `Available: NVDA, AAPL, TSLA, META, MSFT, GOOGL, AMZN, SPY, QQQ`,
      installationId);
    return;
  }

  const tickers = positions.map((p) => p.ticker);
  let prices: Record<string, number> = {};
  try {
    const { getAllPrices } = await import("@workspace/rwa");
    prices = await getAllPrices(tickers);
  } catch {
    // continue without prices
  }

  let table = `@${senderLogin} Your gitStock Portfolio\n\n`;
  table += `| Ticker | Amount | Price | Value | Cost | P&L |\n`;
  table += `|--------|--------|-------|-------|------|-----|\n`;

  let totalValue = 0;
  for (const p of positions) {
    const amount = Number(BigInt(p.amount)) / 1_000_000_000;
    const price = prices[p.ticker] ?? 0;
    const value = amount * price;
    const cost = Number(BigInt(p.costBasisUsdc)) / 1_000_000;
    const pnl = value - cost;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
    totalValue += value;
    table += `| git${p.ticker} | ${amount.toFixed(4)} | $${price.toFixed(2)} | $${value.toFixed(2)} | $${cost.toFixed(2)} | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) |\n`;
  }

  table += `\n**Total Portfolio Value:** $${totalValue.toFixed(2)} USD`;

  await postGitHubComment(repo, issueNumber, table, installationId);
}

async function handleLaunchToken(
  intent: ParsedIntent,
  user: { githubId: number; githubLogin?: string | null; ownerAddress?: string | null },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
  fromMcp = false,
  creatorWallet: string | null = null,
  aiClient = "mcp",
): Promise<void> {
  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as `0x${string}` | undefined;
  if (!deployerPk) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Token launch is not configured on this instance (missing deployer key).`,
      installationId);
    return;
  }

  const name = intent.token_name?.trim() ?? null;
  const symbol = intent.token_symbol?.trim().toUpperCase() ?? null;
  const description = intent.token_description?.trim() ?? null;
  const link = intent.token_link?.trim() ?? null;
  const xLink = intent.token_x?.trim() ?? null;
  const logo = intent.token_logo?.trim() ?? null;

  if (!name || !symbol) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Please provide a token name and symbol. Example:\n\n` +
      `\`@gitbankbot launch token "My Token" symbol MTK description "A token for my project" link https://myproject.com\`\n\n` +
      `You can also attach a logo image directly to this comment (drag and drop or paste) instead of providing a logo URL.`,
      installationId);
    return;
  }

  // ── MCP launch: verify 0.01 ETH deposit before proceeding ─────────────────
  let ethDepositTxHash: string | null = null;
  if (fromMcp) {
    if (!creatorWallet) {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} MCP token launches require a creator wallet address. Please run the launch command again from your AI assistant and include your wallet address.`,
        installationId);
      return;
    }
    const { verified, txHash: depositTx } = await verifyEthDepositViaBasescan(
      creatorWallet,
      LAUNCH_TOKEN_DEV_WALLET,
      MCP_LAUNCH_ETH_WEI,
    );
    if (!verified) {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} ETH deposit not found. Please send 0.01 ETH from \`${creatorWallet}\` to \`${LAUNCH_TOKEN_DEV_WALLET}\` on Base Mainnet, then confirm again.\n\n` +
        `Tip: make sure the transaction is confirmed on-chain before reconfirming.`,
        installationId);
      return;
    }
    ethDepositTxHash = depositTx;
    logger.info({ depositTx, creatorWallet }, "MCP launch: ETH deposit verified");
  }

  // creator = the user's ownerAddress. Falls back to dev wallet if no keypair yet.
  const creatorAddress = (user.ownerAddress ?? LAUNCH_TOKEN_DEV_WALLET) as `0x${string}`;

  // Build viem clients — deployer wallet pays gas, same pattern as vault relayer
  const isMainnet = process.env["BASE_NETWORK"] === "mainnet";
  const chain = isMainnet ? base : baseSepolia;
  const primaryRpc = isMainnet
    ? (process.env["BASE_MAINNET_RPC_URL"] ?? process.env["BASE_RPC_URL"])
    : (process.env["BASE_SEPOLIA_RPC_URL"] ?? process.env["BASE_RPC_URL"]);
  const fallbackRpcs = isMainnet
    ? ["https://mainnet.base.org", "https://base.llamarpc.com", "https://base-rpc.publicnode.com"]
    : ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"];
  const rpcTransport = fallback([
    ...(primaryRpc ? [http(primaryRpc)] : []),
    ...fallbackRpcs.map(u => http(u)),
  ]);
  const account = privateKeyToAccount(deployerPk);
  const publicClient = createPublicClient({ chain, transport: rpcTransport });
  const walletClient = createWalletClient({ account, chain, transport: rpcTransport });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clanker = new Clanker({ publicClient: publicClient as any, wallet: walletClient as any });

  // Rewards: split LP trading fees between creator and Gitbank platform (in bps, total = 10000)
  const tokenConfig = {
    name,
    symbol,
    tokenAdmin: creatorAddress,
    ...(logo && { image: logo }),
    ...((description || link || xLink) ? {
      metadata: {
        ...(description && { description }),
        ...((link || xLink) && {
          socialMediaUrls: [
            ...(link ? [{ platform: "website", url: link }] : []),
            ...(xLink ? [{ platform: "x", url: xLink }] : []),
          ],
        }),
        auditUrls: [] as string[],
      },
    } : {}),
    context: {
      interface: "Gitbank",
      platform: "github",
      messageId: `${repo}#${issueNumber}`,
      id: String(user.githubId),
    },
    rewards: {
      recipients: [
        {
          recipient: creatorAddress,
          admin: creatorAddress,
          bps: LAUNCH_TOKEN_CREATOR_BPS,
          token: "Both" as const,
        },
        {
          recipient: LAUNCH_TOKEN_DEV_WALLET,
          admin: LAUNCH_TOKEN_DEV_WALLET,
          bps: LAUNCH_TOKEN_DEV_BPS,
          token: "Both" as const,
        },
      ],
    },
  };

  let contractAddress: string | null = null;
  let txHash: string | null = null;
  let deployTxHashHex: `0x${string}` | null = null;

  try {
    const { txHash: deployTxHash, waitForTransaction, error: deployError } = await clanker.deploy(tokenConfig);
    if (deployError) throw deployError;
    txHash = deployTxHash ?? null;
    deployTxHashHex = (deployTxHash ?? null) as `0x${string}` | null;

    const { address, error: waitError } = await waitForTransaction();
    if (waitError) throw waitError;
    contractAddress = address ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Token launch failed: ${msg}\n\nPlease try again or contact the team.`,
      installationId);
    return;
  }

  if (!contractAddress) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Token submitted but address is still pending. Check clanker.world shortly.`,
      installationId);
    return;
  }

  const clankerLink = `https://www.clanker.world/clanker/${contractAddress}`;
  const creatorPct = LAUNCH_TOKEN_CREATOR_BPS / 100;
  const devPct = LAUNCH_TOKEN_DEV_BPS / 100;
  const lines = [
    `Token Name    : ${name}`,
    `Symbol        : ${symbol}`,
    `Contract      : ${contractAddress}`,
    `Network       : ${NETWORK_LABEL}`,
    ...(txHash ? [`Deploy Tx     : ${txHash}`] : []),
    ...(link ? [`Website       : ${link}`] : []),
    ...(xLink ? [`X / Twitter   : ${xLink}`] : []),
    `LP Rewards    : ${creatorPct}% creator / ${devPct}% platform`,
    `Creator Addr  : ${creatorAddress}`,
  ];

  // Persist to DB
  const chainId = process.env["BASE_NETWORK"] === "mainnet" ? 8453 : 84532;
  const [insertedToken] = await db.insert(launchedTokensTable).values({
    tokenName: name,
    tokenSymbol: symbol,
    contractAddress: contractAddress,
    deployerGithubLogin: user.githubLogin ?? senderLogin,
    deployerGithubId: user.githubId,
    txHash: txHash ?? null,
    chainId,
    websiteUrl: link ?? null,
    twitterUrl: xLink ?? null,
    imageUrl: logo ?? null,
    source: fromMcp ? "mcp" : "github_bot",
    creatorWallet: creatorWallet ?? null,
    ethDepositTx: ethDepositTxHash ?? null,
  }).onConflictDoNothing().returning({ id: launchedTokensTable.id });

  // ── MCP post-launch: buy token + distribute to $GITBANK holders + tweet ────
  const distributionLines: string[] = [];
  if (fromMcp && insertedToken) {
    try {
      // Resolve V4 pool info from the deploy tx receipt so we can skip the
      // clanker.world REST API (which is unreliable for freshly deployed tokens
      // and returns empty responses). poolInfo is null-safe: if resolution fails
      // buyTokenWithEthFromDeployer falls back to clanker.world then V3.
      const WETH_ADDR = "0x4200000000000000000000000000000000000006" as Address;
      const poolInfo = deployTxHashHex
        ? await getPoolInfoFromDeployReceipt(deployTxHashHex, WETH_ADDR)
        : null;

      if (!poolInfo) {
        logger.warn({ contractAddress, deployTxHashHex }, "MCP launch: could not resolve V4 pool from receipt, will attempt fallback");
      }

      const { tokensBought, buyTxHash } = await buyTokenWithEthFromDeployer(
        contractAddress as Address,
        MCP_LAUNCH_ETH_WEI,
        poolInfo ?? undefined,
      );
      logger.info({ contractAddress, tokensBought: tokensBought.toString(), buyTxHash }, "MCP launch: tokens bought");

      const holders = await getGitbankHolders();
      const distributed = await distributeNewTokenToHolders(
        contractAddress as Address,
        tokensBought,
        holders,
        insertedToken.id,
      );
      distributionLines.push(
        `Buy Tx       : ${buyTxHash}`,
        `Distributed  : ${distributed} $GITBANK holders`,
        `Tokens Bought: ${(Number(tokensBought) / 1e18).toFixed(4)} ${symbol}`,
      );

      const aiLabel = aiClient && aiClient !== "mcp"
        ? aiClient.charAt(0).toUpperCase() + aiClient.slice(1)
        : "an AI";
      const tweetText =
        `New token launched on Base via Gitbank MCP!\n\n` +
        `${name} ($${symbol}) deployed by @${senderLogin} using ${aiLabel}\n\n` +
        (tokensBought > 0n ? `0.01 ETH bought $${symbol} and airdropped to all $GITBANK holders\n\n` : "") +
        `CA: ${contractAddress}\n\ngitbank.io`;
      try {
        await postTweet(tweetText);
      } catch (tweetErr) {
        logger.warn({ tweetErr }, "MCP launch: tweet failed (non-fatal)");
      }
    } catch (distErr) {
      logger.error({ distErr, contractAddress }, "MCP launch: buy/distribute failed");
    }
  }

  const receiptExtra = distributionLines.length > 0 ? "\n" + distributionLines.join("\n") : "";

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Token launched!\n\n` +
    "```\n" +
    "Gitbank x Clanker Receipt\n" +
    "-".repeat(48) + "\n" +
    lines.join("\n") +
    receiptExtra + "\n" +
    "-".repeat(48) + "\n" +
    "```\n" +
    `[View on Clanker](${clankerLink}) | [View on Basescan](${EXPLORER_ADDR}/${contractAddress})`,
    installationId);
}

async function handleIssueComment(payload: Record<string, unknown>): Promise<void> {
  const comment = payload["comment"] as Record<string, unknown>;
  const issue = payload["issue"] as Record<string, unknown>;
  const repo = (payload["repository"] as Record<string, unknown>)["full_name"] as string;
  const sender = payload["sender"] as Record<string, unknown>;
  const installation = payload["installation"] as Record<string, unknown> | undefined;
  const installationId = (installation?.["id"] as number) ?? 0;

  const commentBody = comment["body"] as string;
  const issueNumber = issue["number"] as number;
  const issueTitle = issue["title"] as string;
  const senderGithubId = sender["id"] as number;
  const senderLogin = sender["login"] as string;
  const senderType = (sender["type"] as string | undefined) ?? "";

  logger.info({ senderLogin, senderType, commentSnippet: commentBody.slice(0, 120) }, "webhook: comment received");

  if (!commentBody.toLowerCase().includes("@gitbankbot")) {
    logger.info({ senderLogin }, "webhook: skip — no @gitbankbot mention");
    return;
  }

  // Never process bot comments — prevents infinite reply loops.
  if (senderType === "Bot" || senderLogin.toLowerCase().includes("[bot]")) {
    logger.info({ senderLogin }, "webhook: skip — bot sender");
    return;
  }

  // Blocked accounts — silently drop, no reply
  const BLOCKED_LOGINS = new Set(["ognome-dev"]);
  if (BLOCKED_LOGINS.has(senderLogin.toLowerCase())) {
    logger.info({ senderLogin }, "webhook: skip — blocked login");
    return;
  }

  if (!checkRateLimit(senderGithubId)) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Rate limit reached. You can send 10 commands per hour. Please try again later.`,
      installationId);
    return;
  }

  const logId = await db.insert(commandLogTable).values({
    githubId: senderGithubId,
    repo,
    issueNumber,
    commandText: commentBody,
    intent: null,
    result: "pending",
  }).returning({ id: commandLogTable.id });

  // ── MCP confirm shortcut ────────────────────────────────────────────────────
  // Matches: @gitbankbot confirm mcp<hex>  OR  @gitbankbot mcp<hex>
  // "confirm" is optional — the mcp code is machine-generated and unambiguous.
  // Skips NLP entirely.
  const MCP_CONFIRM_RE = /@gitbankbot\s+(?:confirm\s+)?(mcp[0-9a-f]+)/i;
  const mcpMatch = commentBody.match(MCP_CONFIRM_RE);
  if (mcpMatch) {
    const confirmCode = mcpMatch[1]!.toLowerCase();
    await db.update(commandLogTable)
      .set({ intent: "confirm_mcp" })
      .where(eq(commandLogTable.id, logId[0]!.id));

    const [pending] = await db.select().from(mcpPendingTable)
      .where(eq(mcpPendingTable.confirmCode, confirmCode)).limit(1);

    if (!pending) {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} Confirm code \`${confirmCode}\` not found. It may have already been used or never existed.`,
        installationId);
      return;
    }
    if (pending.status !== "pending") {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} This command is already **${pending.status}**. Nothing to do.`,
        installationId);
      return;
    }
    if (new Date() > pending.expiresAt) {
      await db.update(mcpPendingTable).set({ status: "expired" })
        .where(eq(mcpPendingTable.confirmCode, confirmCode));
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} This confirm code has **expired** (codes are valid for 10 minutes). Please run the request again from your AI assistant.`,
        installationId);
      return;
    }
    if (pending.githubUsername.toLowerCase() !== senderLogin.toLowerCase()) {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} This command was requested by **@${pending.githubUsername}**. Only they can confirm it.`,
        installationId);
      return;
    }

    // Mark confirmed — load user + execute
    await db.update(mcpPendingTable).set({ status: "confirmed" })
      .where(eq(mcpPendingTable.confirmCode, confirmCode));

    const userRows = await db.select().from(usersTable)
      .where(eq(usersTable.githubId, senderGithubId)).limit(1);
    const mcpUser = userRows[0];

    // ── launch_token: no vault required — bypass vault check ──────────────────
    if (pending.command === "launch_token") {
      const p2 = pending.params as Record<string, unknown>;
      // If user attached a logo image in the confirm comment, use it as logo override.
      // Supports GitHub-hosted image attachments (drag-drop/paste) and plain image URLs.
      // Match GitHub user-attachments (no extension), OR any image URL with extension
      const IMAGE_RE = /!\[.*?\]\((https?:\/\/(?:github\.com\/user-attachments\/assets\/[\w-]+|\S+?\.(?:png|jpg|jpeg|gif|webp)(?:\?[^)]*)??))\)|(?:^|\s)(https?:\/\/(?:github\.com\/user-attachments\/assets\/[\w-]+|\S+?\.(?:png|jpg|jpeg|gif|webp)(?:\?\S*)?))/i;
      const imageMatch = commentBody.match(IMAGE_RE);
      const logoFromComment = imageMatch ? (imageMatch[1] ?? imageMatch[2] ?? null) : null;
      const resolvedLogo = logoFromComment ?? (p2["logo"] as string | undefined) ?? null;
      try {
        await handleLaunchToken(
          { intent: "launch_token", token_name: p2["name"] as string, token_symbol: p2["symbol"] as string, token_description: p2["description"] as string, token_link: (p2["link"] as string | undefined) ?? null, token_x: (p2["x"] as string | undefined) ?? null, token_logo: resolvedLogo, token_in: null, token_out: null, amount: null, recipient: null, project_name: null, issue_id: null, contributor: null, confidence: 1, language: "en" },
          { githubId: senderGithubId, githubLogin: senderLogin, ownerAddress: mcpUser?.ownerAddress ?? null },
          repo, issueNumber, senderLogin, installationId,
          true,
          (p2["creator_wallet"] as string | null) ?? null,
          (p2["ai_client"] as string | null) ?? "mcp",
        );
        await db.update(mcpPendingTable).set({ status: "executed", resultText: "Token launched via MCP" })
          .where(eq(mcpPendingTable.confirmCode, confirmCode));
        await db.update(commandLogTable).set({ result: "success" })
          .where(eq(commandLogTable.id, logId[0]!.id));
      } catch (err) {
        logger.error({ err, confirmCode }, "webhook: mcp launch_token failed");
        await db.update(mcpPendingTable).set({ status: "pending" })
          .where(eq(mcpPendingTable.confirmCode, confirmCode));
        await db.update(commandLogTable).set({ result: "failure" })
          .where(eq(commandLogTable.id, logId[0]!.id));
        await postGitHubComment(repo, issueNumber,
          `@${senderLogin} Token launch failed. Please try again.`,
          installationId);
      }
      return;
    }

    if (!mcpUser?.encryptedPk || !mcpUser?.vaultAddress) {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} Your vault is not set up yet. Visit https://gitbank.io to deploy your vault first.`,
        installationId);
      return;
    }

    const vaultUser = { encryptedPk: mcpUser.encryptedPk, vaultAddress: mcpUser.vaultAddress, githubId: senderGithubId };
    const p = pending.params as Record<string, unknown>;

    // ── send_calls mode: build calldata, post execute token, let user submit ──
    if (pending.executionMode === "send_calls") {
      const supportedCommands = ["deposit", "withdraw", "swap"];
      if (!supportedCommands.includes(pending.command)) {
        await postGitHubComment(repo, issueNumber,
          `@${senderLogin} send_calls mode is only supported for deposit, withdraw, and swap. Falling back to relayer execution.`,
          installationId);
      } else {
        try {
          const executeToken = "exec" + crypto.randomBytes(6).toString("hex");
          const executeTokenExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

          const payload = await buildSendCallsPayload(
            pending.command as "deposit" | "withdraw" | "swap",
            mcpUser.encryptedPk,
            mcpUser.vaultAddress,
            BigInt(senderGithubId),
            p,
          );

          await db.update(mcpPendingTable).set({
            status: "ready_to_execute",
            executeToken,
            executeCalldata: payload,
            executeTokenExpiresAt,
          }).where(eq(mcpPendingTable.confirmCode, confirmCode));

          await db.update(commandLogTable).set({ result: "success" })
            .where(eq(commandLogTable.id, logId[0]!.id));

          await postGitHubComment(repo, issueNumber,
            `@${senderLogin} Identity confirmed. Your signed transaction is ready.\n\n` +
            `**Step 1** - Tell your AI assistant to fetch the calldata:\n` +
            `\`GET https://gitbank.io/api/public/execute/${executeToken}\`\n\n` +
            `**Step 2** - Submit via Base MCP:\n` +
            `Pass the returned \`calls\` array to \`wallet_sendCalls\` from your Coinbase Wallet / Base Account.\n\n` +
            `Token expires in **10 minutes** and is **single-use**.`,
            installationId);
        } catch (err) {
          logger.error({ err, confirmCode }, "webhook: send_calls calldata build failed");
          await db.update(mcpPendingTable).set({ status: "pending" })
            .where(eq(mcpPendingTable.confirmCode, confirmCode));
          await db.update(commandLogTable).set({ result: "failure" })
            .where(eq(commandLogTable.id, logId[0]!.id));
          await postGitHubComment(repo, issueNumber,
            `@${senderLogin} Failed to build transaction calldata. Please try again.`,
            installationId);
        }
        return;
      }
    }

    try {
      switch (pending.command) {
        case "deposit":
          await handleDeposit(
            { intent: "deposit", token_in: p["token"] as string, amount: p["amount"] as number, token_out: null, recipient: null, project_name: null, issue_id: null, contributor: null, confidence: 1, language: "en" },
            vaultUser, repo, issueNumber, senderLogin, installationId,
          );
          break;
        case "withdraw":
          await handleWithdraw(
            { intent: "withdraw", token_in: p["token"] as string, amount: p["amount"] as number, recipient: p["to_address"] as string, token_out: null, project_name: null, issue_id: null, contributor: null, confidence: 1, language: "en" },
            vaultUser, repo, issueNumber, senderLogin, installationId,
          );
          break;
        case "swap":
          await handleSwap(
            { intent: "swap", token_in: p["from_token"] as string, token_out: p["to_token"] as string, amount: p["amount"] as number, recipient: null, project_name: null, issue_id: null, contributor: null, confidence: 1, language: "en" },
            vaultUser, repo, issueNumber, senderLogin, installationId,
          );
          break;
        case "transfer":
          await handleTransfer(
            { intent: "transfer", token_in: p["token"] as string, amount: p["amount"] as number, recipient: `@${p["to_github_username"] as string}`, token_out: null, project_name: null, issue_id: null, contributor: null, confidence: 1, language: "en" },
            vaultUser, repo, issueNumber, senderLogin, installationId,
          );
          break;
        case "assign_bounty":
          await handleAssignBounty(
            { intent: "assign_bounty", token_in: p["token"] as string, amount: p["amount"] as number, contributor: p["contributor"] as string, issue_id: p["issue_number"] as number, project_name: null, recipient: null, token_out: null, confidence: 1, language: "en" },
            vaultUser, repo, issueNumber, senderLogin, installationId,
          );
          break;
        case "buy_stock":
          await handleBuyStock(
            { intent: "buy_stock", ticker: p["ticker"] as string, token_in: "USDC", amount: p["usdc_amount"] as number, token_out: null, recipient: null, project_name: null, issue_id: null, contributor: null, confidence: 1, language: "en" },
            vaultUser, repo, issueNumber, senderLogin, installationId,
          );
          break;
        case "sell_stock":
          await handleSellStock(
            { intent: "sell_stock", ticker: p["ticker"] as string, amount: p["amount"] as number, token_in: null, token_out: null, recipient: null, project_name: null, issue_id: null, contributor: null, confidence: 1, language: "en" },
            vaultUser, repo, issueNumber, senderLogin, installationId,
          );
          break;
        default:
          await postGitHubComment(repo, issueNumber,
            `@${senderLogin} Unknown pending command type: \`${pending.command}\`.`,
            installationId);
          return;
      }

      // Capture latest tx for this user so Claude can read it via check_pending
      let resultText = `Command executed: ${pending.command}`;
      try {
        const [latestTx] = await db
          .select()
          .from(transactionsTable)
          .where(eq(transactionsTable.githubId, senderGithubId))
          .orderBy(desc(transactionsTable.createdAt))
          .limit(1);
        if (latestTx?.txHash) {
          const p2 = pending.params as Record<string, unknown>;
          const amountIn = latestTx.amountIn
            ? (Number(latestTx.amountIn) / 10 ** (latestTx.tokenIn === "USDC" ? 6 : 18)).toFixed(latestTx.tokenIn === "USDC" ? 2 : 6)
            : String(p2["amount"] ?? "");
          const amountOut = latestTx.amountOut
            ? (Number(latestTx.amountOut) / 10 ** (latestTx.tokenOut === "USDC" ? 6 : 18)).toFixed(latestTx.tokenOut === "USDC" ? 2 : 6)
            : null;
          resultText = [
            `command: ${pending.command}`,
            `status: confirmed`,
            amountIn && latestTx.tokenIn ? `amount_in: ${amountIn} ${latestTx.tokenIn}` : null,
            amountOut && latestTx.tokenOut ? `amount_out: ${amountOut} ${latestTx.tokenOut}` : null,
            `tx_hash: ${latestTx.txHash}`,
            `basescan: ${EXPLORER}/${latestTx.txHash}`,
          ].filter(Boolean).join("\n");
        }
      } catch {
        // non-fatal — result_text stays generic
      }

      await db.update(mcpPendingTable).set({ status: "executed", resultText })
        .where(eq(mcpPendingTable.confirmCode, confirmCode));
      await db.update(commandLogTable).set({ result: "success" })
        .where(eq(commandLogTable.id, logId[0]!.id));
    } catch (err) {
      logger.error({ err, confirmCode, command: pending.command }, "webhook: mcp confirm execution failed");
      await db.update(mcpPendingTable).set({ status: "pending" })
        .where(eq(mcpPendingTable.confirmCode, confirmCode));
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} Command execution failed. Please try again.`,
        installationId);
    }
    return;
  }
  // ── End MCP confirm ─────────────────────────────────────────────────────────

  const intent = await parseIntent(commentBody, issueTitle);
  _webhookLang = intent.language ?? "en";

  await db.update(commandLogTable)
    .set({ intent: intent.intent })
    .where(eq(commandLogTable.id, logId[0]!.id));

  // Low confidence or unknown
  if (intent.confidence < 0.70 || intent.intent === "unknown") {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} I could not understand that command. Try:\n` +
      `- \`@gitbankbot balance\` - check your vault balance\n` +
      `- \`@gitbankbot deposit 50 USDC\` - deposit tokens\n` +
      `- \`@gitbankbot help\` - full command reference`,
      installationId);
    return;
  }

  // Medium confidence: ask for confirmation
  if (intent.confidence >= 0.70 && intent.confidence < 0.85) {
    const summary = `Intent: ${intent.intent}` +
      (intent.amount ? `, Amount: ${intent.amount}` : "") +
      (intent.token_in ? ` ${intent.token_in}` : "") +
      (intent.token_out ? ` -> ${intent.token_out}` : "") +
      (intent.recipient ? `, To: ${intent.recipient}` : "");
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} I understood: **${summary}**\n\n` +
      `Reply \`@gitbankbot confirm\` to execute, or \`@gitbankbot cancel\` to abort.`,
      installationId);
    return;
  }

  // Help -- no auth needed
  if (intent.intent === "help") {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} **Gitbank Commands**\n\n` +
      `**Before your first deposit**\n` +
      `Your vault has an owner address (visible at https://gitbank.io/app/keys). Send WETH or USDC to that address from any wallet first, then use the deposit command below.\n\n` +
      `**Personal Vault**\n` +
      `- \`@gitbankbot balance\` - view your vault balances\n` +
      `- \`@gitbankbot deposit 50 USDC\` - lock tokens into vault\n` +
      `- \`@gitbankbot claim\` - shield any unlocked balance (e.g. LP fees) into your vault\n` +
      `- \`@gitbankbot withdraw 50 USDC to 0x...\` - send tokens to any wallet\n` +
      `- \`@gitbankbot swap 0.01 WETH to USDC\` - swap locked tokens\n` +
      `- \`@gitbankbot send 20 USDC to @alice\` - transfer to contributor\n` +
      `- \`@gitbankbot cancel\` - cancel a pending deposit watcher\n\n` +
      `**Project Workspace**\n` +
      `- \`@gitbankbot create project 'Sprint 1' with 1000 USDC budget\`\n` +
      `- \`@gitbankbot assign this task to @alice with 80 USDC bounty\`\n` +
      `- \`@gitbankbot project status Sprint 1\`\n` +
      `- \`@gitbankbot cancel this task and reclaim bounty\`\n\n` +
      `**Token Launch**\n` +
      `Launch a token on Base Mainnet via Clanker. The bot deploys the token, creates a Uniswap v4 liquidity pool, and posts the contract address and Basescan link back to this thread. 80% of all LP trading fees go to your wallet automatically.\n\n` +
      `Syntax:\n` +
      `\`@gitbankbot launch token "Name" symbol TICKER description "..." link <url> [x <twitter_url>] [image <image_url>]\`\n\n` +
      `Parameters:\n` +
      `- \`"Name"\` - token name (required)\n` +
      `- \`symbol\` - ticker symbol, 2-8 chars (required)\n` +
      `- \`description\` - short description (required)\n` +
      `- \`link\` - project website URL (required)\n` +
      `- \`x\` - X / Twitter profile URL (optional)\n` +
      `- \`image\` - token logo URL or attach an image to your comment (optional)\n\n` +
      `Example:\n` +
      `\`@gitbankbot launch token "Dev Fund" symbol DEV description "Funding open source contributors" link https://myproject.com x https://x.com/myproject\`\n\n` +
      `**x402 API Payments**\n` +
      `Pay any x402-compatible API directly from your vault:\n` +
      `- \`@gitbankbot x402-pay https://api.example.com/data 0.01 USDC\`\n\n` +
      `The bot probes the URL, reads the payment terms, verifies the amount is within your approved limit, and sends USDC from your vault directly to the API provider. Works with any API that uses the x402 open standard (HTTP 402 + PAYMENT-REQUIRED header).\n\n` +
      `All commands work in any language.\n` +
      `Docs: https://gitbank.io/docs`,
      installationId);
    return;
  }

  // Load user -- auto-create on first contact
  const userRows = await db.select().from(usersTable)
    .where(eq(usersTable.githubId, senderGithubId)).limit(1);
  let user = userRows[0];

  if (!user) {
    await db.insert(usersTable).values({ githubId: senderGithubId, githubLogin: senderLogin, role: "member" });
    const created = await db.select().from(usersTable).where(eq(usersTable.githubId, senderGithubId)).limit(1);
    user = created[0]!;
  }

  // Auto-deploy vault if this is the user's first command
  if (!user.encryptedPk) {
    const kp = generateKeypair();
    const encryptedPk = encryptPrivateKey(kp.privateKey);
    await db.update(usersTable)
      .set({ ownerAddress: kp.address, encryptedPk })
      .where(eq(usersTable.githubId, senderGithubId));
    // Sync in-memory user object so the rest of this request (e.g. launch_token
    // creatorAddress) uses the correct values already persisted to DB.
    user.ownerAddress = kp.address;
    user.encryptedPk = encryptedPk;
    let deployResult: { txHash: string };
    try {
      deployResult = await deployVault(encryptedPk, BigInt(senderGithubId), kp.address as Address);
    } catch (err) {
      logger.error({ err }, "webhook: vault auto-deploy failed");
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} Vault deployment failed. Please try again in a moment.`,
        installationId);
      return;
    }

    // Post "deploying" comment and save comment ID so we can edit it later
    const deployCommentId = await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Vault deploying...\n\n` +
      "```\n" +
      `Network   : ${NETWORK_LABEL}\n` +
      `Deploy tx : ${EXPLORER}/${deployResult.txHash}\n` +
      "```\n\n" +
      `Waiting for confirmation on Base...`,
      installationId);

    // Blocking poll: wait for vault address to resolve on-chain (Base ~2s blocks, max ~60s)
    let vaultAddress: string | null = null;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const addr = await getVaultByGithubId(BigInt(senderGithubId));
        if (addr && addr !== "0x0000000000000000000000000000000000000000") {
          vaultAddress = addr;
          await db.update(usersTable).set({ vaultAddress: addr }).where(eq(usersTable.githubId, senderGithubId));
          break;
        }
      } catch { /* keep polling */ }
    }

    if (!vaultAddress) {
      const msg =
        `@${senderLogin} Vault deploy submitted but address is taking longer than expected to confirm.\n\n` +
        "```\n" +
        `Network   : ${NETWORK_LABEL}\n` +
        `Deploy tx : ${EXPLORER}/${deployResult.txHash}\n` +
        "```\n\n" +
        `Run \`@gitbankbot balance\` in 30 seconds to check, then retry your command.`;
      if (deployCommentId) {
        await updateGitHubComment(deployCommentId, repo, msg, installationId);
      } else {
        await postGitHubComment(repo, issueNumber, msg, installationId);
      }
      return;
    }

    // Vault confirmed — edit comment with final status + vault address
    const confirmedMsg =
      `@${senderLogin} Vault ready!\n\n` +
      "```\n" +
      `Network   : ${NETWORK_LABEL}\n` +
      `Vault     : ${vaultAddress}\n` +
      `Deploy tx : ${deployResult.txHash}\n` +
      "```\n" +
      `[View vault](${EXPLORER_ADDR}/${vaultAddress}) | [Deploy tx](${EXPLORER}/${deployResult.txHash})`;
    if (deployCommentId) {
      await updateGitHubComment(deployCommentId, repo, confirmedMsg, installationId);
    } else {
      await postGitHubComment(repo, issueNumber, confirmedMsg, installationId);
    }

    // Auto-continue with original command using the freshly deployed vault
    const freshUser = { encryptedPk, vaultAddress, githubId: senderGithubId };
    if (intent.intent === "deposit") {
      await handleDeposit(intent, freshUser, repo, issueNumber, senderLogin, installationId);
    } else if (intent.intent === "withdraw") {
      await handleWithdraw(intent, freshUser, repo, issueNumber, senderLogin, installationId);
    } else if (intent.intent === "swap") {
      await handleSwap(intent, freshUser, repo, issueNumber, senderLogin, installationId);
    } else if (intent.intent === "transfer") {
      await handleTransfer(intent, freshUser, repo, issueNumber, senderLogin, installationId);
    } else if (intent.intent === "create_project") {
      await handleCreateProject(intent, freshUser, repo, issueNumber, senderLogin, installationId);
    } else if (intent.intent === "claim") {
      // re-use freshUser so vaultAddress is available immediately after deploy
      Object.assign(user, freshUser);
    }
    return;
  }

  // Vault deployed but tx not yet confirmed (address still resolving)
  if (!user.vaultAddress) {
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Your vault is still confirming on-chain. ` +
      `Please wait about 30 seconds and try again.\n\n` +
      `Run \`@gitbankbot balance\` to check when it's ready.`,
      installationId);
    return;
  }

  // Balance check -- reads on-chain gitToken balances for all supported tokens
  if (intent.intent === "balance_check") {
    const vault = user.vaultAddress as Address;
    const tokens = getAllTokens();
    const balances = await Promise.all(
      tokens.map(async (t) => {
        try {
          const raw = await readVaultBalance(vault, t.address);
          const human = (Number(raw) / 10 ** t.decimals).toFixed(t.decimals === 6 ? 2 : 6);
          return `git${t.symbol.padEnd(6)} : ${human}`;
        } catch {
          return `git${t.symbol.padEnd(6)} : -`;
        }
      }),
    );
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin}\n` +
      "```\n" +
      `Vault   : ${vault}\n` +
      `Network : ${process.env["BASE_NETWORK"] === "mainnet" ? "Base Mainnet" : "Base Sepolia"}\n` +
      `\n` +
      `Locked balances\n` +
      `───────────────\n` +
      balances.join("\n") + "\n" +
      "```\n" +
      `Dashboard: https://gitbank.io/app/dashboard`,
      installationId);
    return;
  }

  // Claim -- shield all unlocked ERC-20 balances sitting in the vault (e.g. LP fees)
  if (intent.intent === "claim") {
    const vault = user.vaultAddress as Address;
    const tokens = getAllTokens();
    const claimed: string[] = [];

    for (const t of tokens) {
      try {
        const available = await readVaultAvailableDeposit(vault, t.address as Address);
        if (available === 0n) continue;
        const nonce = await readVaultNonce(vault);
        const result = await lockDeposit(
          user.encryptedPk!, vault, BigInt(senderGithubId),
          t.address as Address, available, nonce,
        );
        const human = (Number(available) / 10 ** t.decimals).toFixed(t.decimals === 6 ? 2 : 6);
        claimed.push(`git${t.symbol.padEnd(6)} : +${human} | ${EXPLORER}/${result.txHash}`);
      } catch (err) {
        logger.warn({ err, token: t.symbol }, "claim: gitShield failed");
      }
    }

    if (claimed.length === 0) {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} No unlocked balance found in your vault. Nothing to claim.\n\n` +
        `LP fees land in your vault automatically after each trade. ` +
        `Run \`@gitbankbot claim\` again once fees have accumulated.`,
        installationId);
    } else {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} Claimed and locked into vault:\n\n` +
        "```\n" +
        claimed.join("\n") + "\n" +
        "```\n\n" +
        `Dashboard: https://gitbank.io/app/dashboard`,
        installationId);
    }
    return;
  }

  // Cancel -- abort any pending deposit poller for this user (no vault required)
  if (intent.intent === "cancel") {
    const pendingRows = await db.select().from(pendingDepositsTable)
      .where(eq(pendingDepositsTable.githubId, senderGithubId));

    if (pendingRows.length === 0) {
      await postGitHubComment(repo, issueNumber,
        `@${senderLogin} No active pending commands to cancel.`,
        installationId);
      return;
    }

    // Summarise what we're cancelling before deleting
    const lines = pendingRows.map((r) => {
      const amount = r.amountExpected && r.tokenSymbol
        ? `${(Number(r.amountExpected) / 10 ** (r.tokenSymbol === "USDC" ? 6 : 18)).toFixed(r.tokenSymbol === "USDC" ? 2 : 6)} ${r.tokenSymbol}`
        : "unknown amount";
      return `- Pending deposit: ${amount}`;
    });

    await db.delete(pendingDepositsTable)
      .where(eq(pendingDepositsTable.githubId, senderGithubId));

    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Cancelled. The deposit watcher has been stopped.\n\n` +
      lines.join("\n") + "\n\n" +
      `No tokens were moved. Run a new command whenever you're ready.`,
      installationId);
    return;
  }

  const vaultUser = user as { encryptedPk: string; vaultAddress: string; githubId: number };

  // launch_token does not require vault operations — handle before the vault switch
  if (intent.intent === "launch_token") {
    await handleLaunchToken(intent, user, repo, issueNumber, senderLogin, installationId);
    await db.update(commandLogTable).set({ result: "success" }).where(eq(commandLogTable.id, logId[0]!.id));
    return;
  }

  try {
    switch (intent.intent) {
      case "deposit":
        await handleDeposit(intent, vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "withdraw":
        await handleWithdraw(intent, vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "swap":
        await handleSwap(intent, vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "transfer":
        await handleTransfer(intent, vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "create_project":
        await handleCreateProject(intent, vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "assign_bounty":
        await handleAssignBounty(intent, vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "cancel_task":
        await handleCancelTask(vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "project_status":
        await handleProjectStatus(intent, vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "x402_pay":
        await handleX402Pay(intent, vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "buy_stock":
        await handleBuyStock(intent, vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "sell_stock":
        await handleSellStock(intent, vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "rwa_portfolio":
        await handleRwaPortfolio(vaultUser, repo, issueNumber, senderLogin, installationId);
        break;

      case "history":
        await postGitHubComment(repo, issueNumber,
          `@${senderLogin} View your full transaction history at https://gitbank.io/app/dashboard`,
          installationId);
        break;

      default:
        await postGitHubComment(repo, issueNumber,
          `@${senderLogin} This command is not supported via bot yet. ` +
          `Use \`@gitbankbot help\` for available commands.`,
          installationId);
    }

    await db.update(commandLogTable)
      .set({ result: "success" })
      .where(eq(commandLogTable.id, logId[0]!.id));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.update(commandLogTable)
      .set({ result: "failure" })
      .where(eq(commandLogTable.id, logId[0]!.id));
    await postGitHubComment(repo, issueNumber,
      `@${senderLogin} Transaction failed: ${errMsg.slice(0, 200)}\n\n` +
      `Please check your vault balance at https://gitbank.io/app/dashboard and try again.`,
      installationId);
  }
}

// ── PR merge handler -- auto-payout ────────────────────────────────────────────

async function handlePRMerge(payload: Record<string, unknown>): Promise<void> {
  const pr = payload["pull_request"] as Record<string, unknown>;
  const repo = (payload["repository"] as Record<string, unknown>)["full_name"] as string;
  const installation = payload["installation"] as Record<string, unknown> | undefined;
  const installationId = (installation?.["id"] as number) ?? 0;

  if (!pr["merged"]) return;

  const prNumber = pr["number"] as number;
  const prBody = (pr["body"] as string) ?? "";

  const issueRefs = [...prBody.matchAll(/(?:closes?|fixes?|resolves?)\s+#(\d+)/gi)]
    .map((m) => parseInt(m[1]!, 10));

  for (const issueNumber of issueRefs) {
    const taskRows = await db
      .select()
      .from(tasksTable)
      .where(and(
        eq(tasksTable.issueNumber, issueNumber),
        eq(tasksTable.repo, repo),
        eq(tasksTable.status, "assigned"),
      ))
      .limit(1);

    const task = taskRows[0];
    if (!task) continue;

    // Load project to get owner githubId
    const projectRows = await db.select().from(projectsTable)
      .where(eq(projectsTable.id, task.projectDbId)).limit(1);
    const project = projectRows[0];

    const ownerRows = await db.select().from(usersTable)
      .where(eq(usersTable.githubId, project?.ownerGithubId ?? 0)).limit(1);
    const owner = ownerRows[0];

    if (!owner?.vaultAddress || !owner?.encryptedPk) {
      await postGitHubComment(repo, issueNumber,
        `Gitbank: PR #${prNumber} merged but project owner vault is not set up. Payout skipped.`,
        installationId);
      continue;
    }

    try {
      const vault = owner.vaultAddress as Address;
      const nonce = await readVaultNonce(vault);
      const result = await callVault(owner.encryptedPk, vault, BigInt(owner.githubId), "executeBountyPayout", [
        BigInt(issueNumber), nonce,
      ]);

      await db.update(tasksTable)
        .set({ prNumber, status: "completed" })
        .where(eq(tasksTable.id, task.id));

      await db.insert(transactionsTable).values({
        type: "bounty_payout",
        githubId: owner.githubId,
        tokenOut: task.token,
        amountOut: task.bountyAmount,
        txHash: result.txHash,
        status: "pending",
      });

      await postGitHubComment(repo, issueNumber,
        `Gitbank Payout\n\n` +
        receipt("bounty_payout", result.txHash, [
          `PR         : #${prNumber}`,
          `Amount     : ${task.bountyAmount} ${task.token}`,
        ]),
        installationId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await postGitHubComment(repo, issueNumber,
        `Gitbank: Payout for PR #${prNumber} failed: ${errMsg.slice(0, 200)}`,
        installationId);
    }
  }
}

// ── Installation event handler ────────────────────────────────────────────────

async function handleInstallationEvent(payload: Record<string, unknown>): Promise<void> {
  const action = payload["action"] as string | undefined;
  const inst = payload["installation"] as Record<string, unknown> | undefined;
  if (!inst) return;

  const installationId = inst["id"] as number;
  const account = inst["account"] as Record<string, unknown> | undefined;
  const accountLogin = (account?.["login"] as string) ?? "unknown";
  const accountType = (account?.["type"] as string) ?? "User";
  const suspendedAt = inst["suspended_at"]
    ? new Date(inst["suspended_at"] as string)
    : null;

  if (action === "created" || action === "new_permissions_accepted" || action === "unsuspend") {
    await db
      .insert(installationsTable)
      .values({ installationId, accountLogin, accountType, githubId: null, suspendedAt: null })
      .onConflictDoUpdate({
        target: installationsTable.installationId,
        set: { accountLogin, accountType, suspendedAt: null },
      });
    logger.info({ installationId, accountLogin, action }, "GitHub App installation saved");
  } else if (action === "deleted") {
    await db
      .delete(installationsTable)
      .where(eq(installationsTable.installationId, installationId));
    logger.info({ installationId, action }, "GitHub App installation removed");
  } else if (action === "suspend") {
    await db
      .update(installationsTable)
      .set({ suspendedAt })
      .where(eq(installationsTable.installationId, installationId));
    logger.info({ installationId, action }, "GitHub App installation suspended");
  }
}

// ── Webhook route ─────────────────────────────────────────────────────────────

router.post("/webhook/github", async (req: Request & { rawBody?: Buffer }, res) => {
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  const event = req.headers["x-github-event"] as string | undefined;

  if (!signature || !event) {
    res.status(400).json({ error: "Missing signature or event header" });
    return;
  }

  if (!WEBHOOK_SECRET) {
    res.status(401).json({ error: "Webhook secret not configured on server" });
    return;
  }

  const rawBody = req.rawBody?.toString("utf8") ?? JSON.stringify(req.body);
  if (!verifySignature(rawBody, signature)) {
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  res.json({ message: "received" });

  const payload = req.body as Record<string, unknown>;
  setImmediate(async () => {
    try {
      if (event === "issue_comment" && payload["action"] === "created") {
        _discussionNodeId = null;
        await handleIssueComment(payload);
      } else if (event === "discussion_comment" && payload["action"] === "created") {
        // Normalize discussion payload: inject synthetic "issue" key from "discussion"
        // so handleIssueComment can re-use the same logic without changes.
        const disc = payload["discussion"] as Record<string, unknown>;
        const triggeringComment = payload["comment"] as Record<string, unknown> | undefined;
        const repoPayload = payload["repository"] as Record<string, unknown> | undefined;
        const installId = ((payload["installation"] as Record<string, unknown> | undefined)?.["id"]) as number | undefined;
        _discussionNodeId = disc["node_id"] as string;

        // Determine correct replyToId — must always be a TOP-LEVEL comment node_id.
        // If triggering comment is itself a reply (parent_id present), resolve the parent's node_id.
        const parentDbId = triggeringComment?.["parent_id"] as number | null | undefined;
        if (parentDbId && installId && repoPayload) {
          const owner = (repoPayload["owner"] as Record<string, unknown>)?.["login"] as string;
          const repoName = repoPayload["name"] as string;
          const discNumber = disc["number"] as number;
          try {
            const token = await getInstallationToken(installId);
            _discussionReplyToId = await resolveDiscussionCommentNodeId(token, owner, repoName, discNumber, parentDbId);
          } catch {
            _discussionReplyToId = null;
          }
        } else {
          // Top-level comment — use its own node_id directly as replyToId
          _discussionReplyToId = (triggeringComment?.["node_id"] as string | undefined) ?? null;
        }

        try {
          await handleIssueComment({ ...payload, issue: disc });
        } finally {
          _discussionNodeId = null;
          _discussionReplyToId = null;
        }
      } else if (event === "pull_request" && payload["action"] === "closed") {
        await handlePRMerge(payload);
      } else if (event === "installation") {
        await handleInstallationEvent(payload);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMsg, event }, "Webhook processing error");
    }
  });
});

import { logger } from "../lib/logger";

export default router;
