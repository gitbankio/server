import { Router, type Request } from "express";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { db, usersTable, tasksTable, projectsTable, commandLogTable, transactionsTable, pendingDepositsTable, installationsTable, launchedTokensTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
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
} from "../lib/relayer";
import { generateKeypair, encryptPrivateKey } from "../lib/key-engine";
import { getInstallationToken } from "../lib/github-app";
import { resolveToken, getAllTokens } from "../lib/tokens";
import { keccak256, encodePacked, isAddress, type Address, createPublicClient, createWalletClient, http } from "viem";
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
  "token_logo": "<direct image URL for logo or null>"
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
      target: pendingDepositsTable.trackingAddress,
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
      target: pendingDepositsTable.trackingAddress,
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

// ── launch_token fee config ────────────────────────────────────────────────────
// LP trading fees split between creator and Gitbank platform via Clanker SDK rewards.
// Uses basis points (bps) — total must equal 10000.
const LAUNCH_TOKEN_DEV_WALLET = "0x1e660A9A1f1F08AFEF9c03c96D66260122464CF2" as `0x${string}`;
const LAUNCH_TOKEN_DEV_BPS = 2000;                          // 20% LP fees to dev wallet
const LAUNCH_TOKEN_CREATOR_BPS = 10000 - LAUNCH_TOKEN_DEV_BPS; // 80% to creator

async function handleLaunchToken(
  intent: ParsedIntent,
  user: { githubId: number; githubLogin?: string | null; ownerAddress?: string | null },
  repo: string,
  issueNumber: number,
  senderLogin: string,
  installationId: number,
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

  // creator = the user's ownerAddress. Falls back to dev wallet if no keypair yet.
  const creatorAddress = (user.ownerAddress ?? LAUNCH_TOKEN_DEV_WALLET) as `0x${string}`;

  // Build viem clients — deployer wallet pays gas, same pattern as vault relayer
  const isMainnet = process.env["BASE_NETWORK"] === "mainnet";
  const rpcUrl = isMainnet
    ? (process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org")
    : (process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org");
  const chain = isMainnet ? base : baseSepolia;
  const account = privateKeyToAccount(deployerPk);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

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

  try {
    const { txHash: deployTxHash, waitForTransaction, error: deployError } = await clanker.deploy(tokenConfig);
    if (deployError) throw deployError;
    txHash = deployTxHash ?? null;

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

  // Persist to DB before posting receipt (best-effort — don't block on failure)
  const chainId = process.env["BASE_NETWORK"] === "mainnet" ? 8453 : 84532;
  await db.insert(launchedTokensTable).values({
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
  }).onConflictDoNothing();

  await postGitHubComment(repo, issueNumber,
    `@${senderLogin} Token launched!\n\n` +
    "```\n" +
    "Gitbank x Clanker Receipt\n" +
    "-".repeat(48) + "\n" +
    lines.join("\n") + "\n" +
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

  const rawBody = JSON.stringify(req.body);
  if (WEBHOOK_SECRET && !verifySignature(rawBody, signature)) {
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
