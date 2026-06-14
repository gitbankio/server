import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { db, usersTable, transactionsTable, mcpPendingTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { readVaultBalance } from "../lib/relayer.js";
import { getAllTokens } from "../lib/tokens.js";
import { formatUnits, type Address } from "viem";
import { logger } from "../lib/logger.js";
import crypto from "crypto";
import type { Response } from "express";

const router = Router();
const anthropic = new Anthropic();

type GitHubUser = { login: string; id: number };

// ── SSE helpers ──────────────────────────────────────────────────────────────

function sseId() { return "cplt-" + Date.now(); }

function writeChunk(res: Response, content: string) {
  res.write(
    `data: ${JSON.stringify({ id: sseId(), object: "chat.completion.chunk", choices: [{ delta: { content }, index: 0, finish_reason: null }] })}\n\n`
  );
}

function writeDone(res: Response) {
  res.write(
    `data: ${JSON.stringify({ id: sseId(), object: "chat.completion.chunk", choices: [{ delta: {}, index: 0, finish_reason: "stop" }] })}\n\n`
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

// ── GitHub token verification ─────────────────────────────────────────────────

async function verifyGitHubToken(token: string): Promise<GitHubUser | null> {
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "gitbank-copilot-extension/1.0",
        Accept: "application/vnd.github+json",
      },
    });
    if (!r.ok) return null;
    const u = await r.json() as { login: string; id: number };
    return { login: u.login, id: u.id };
  } catch {
    return null;
  }
}

// ── NLP intent parser ─────────────────────────────────────────────────────────

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
  token_name?: string | null;
  token_symbol?: string | null;
  token_description?: string | null;
}

const SYSTEM_PROMPT = `You are the Gitbank intent parser. Extract structured intent from a command typed by a user in GitHub Copilot.
The user may or may not prefix with @gitbankbot. Extract their intent and return ONLY valid JSON.

Supported intents:
  deposit, withdraw, swap, transfer, balance_check, history, assign_bounty, launch_token, help, unknown

JSON shape (return ONLY this, no explanation):
{"intent":"...","token_in":"USDC|WETH|null","token_out":"USDC|WETH|null","amount":0,"recipient":"@user or 0xaddress or null","project_name":"null","issue_id":null,"contributor":"null","confidence":0.9,"token_name":"null","token_symbol":"null","token_description":"null"}

Rules:
- ETH/WETH both map to "WETH"
- deposit 50 USDC -> intent=deposit, token_in=USDC, amount=50
- swap 10 USDC to WETH -> intent=swap, token_in=USDC, token_out=WETH, amount=10
- send 5 WETH to @alice -> intent=transfer, token_in=WETH, amount=5, recipient=@alice
- withdraw 100 USDC to 0x1234 -> intent=withdraw, token_in=USDC, amount=100, recipient=0x1234
- balance, bal, how much -> intent=balance_check
- history, txs, transactions -> intent=history`;

async function parseIntent(text: string): Promise<ParsedIntent> {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });
    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    return JSON.parse(raw) as ParsedIntent;
  } catch {
    return {
      intent: "unknown", token_in: null, token_out: null, amount: null,
      recipient: null, project_name: null, issue_id: null, contributor: null, confidence: 0,
    };
  }
}

// ── Pending command helpers ───────────────────────────────────────────────────

const CONFIRM_URL = "https://github.com/gitbankio/playground/discussions/4#new_comment_form";

function generateConfirmCode(): string {
  return "mcp" + crypto.randomBytes(4).toString("hex");
}

async function createPendingRecord(
  username: string,
  command: string,
  params: Record<string, unknown>,
): Promise<string> {
  const confirmCode = generateConfirmCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.insert(mcpPendingTable).values({
    githubUsername: username,
    command,
    params,
    confirmCode,
    status: "pending",
    expiresAt,
  });
  return confirmCode;
}

function confirmMsg(code: string, summary: string): string {
  return (
    `${summary}\n\nTo authorize, open:\n${CONFIRM_URL}\n\n` +
    `And post this comment:\n@gitbankbot confirm ${code}\n\n` +
    `(Expires in 10 minutes. Only you can confirm it.)`
  );
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleBalance(res: Response, user: GitHubUser) {
  const [row] = await db.select().from(usersTable).where(eq(usersTable.githubId, user.id)).limit(1);
  if (!row?.vaultAddress) {
    writeChunk(res, `No vault found for @${user.login}.\nVisit https://gitbank.io to deploy your vault first.`);
    return writeDone(res);
  }
  const tokens = getAllTokens().filter((t) => ["WETH", "USDC"].includes(t.symbol)).slice(0, 2);
  const lines: string[] = [`Vault balances for @${user.login} on Base Mainnet:\n`];
  for (const token of tokens) {
    try {
      const raw = await readVaultBalance(row.vaultAddress as Address, token.address as Address);
      const fmt = parseFloat(formatUnits(raw, token.decimals)).toFixed(token.symbol === "USDC" ? 2 : 6);
      lines.push(`  ${token.symbol.padEnd(6)}  ${fmt}`);
    } catch {
      lines.push(`  ${token.symbol.padEnd(6)}  (read error)`);
    }
  }
  lines.push(`\nVault: ${row.vaultAddress}`);
  lines.push(`Basescan: https://basescan.org/address/${row.vaultAddress}`);
  writeChunk(res, lines.join("\n"));
  writeDone(res);
}

async function handleHistory(res: Response, user: GitHubUser) {
  const rows = await db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.githubId, user.id))
    .orderBy(desc(transactionsTable.createdAt))
    .limit(5);
  if (rows.length === 0) {
    writeChunk(res, `No transactions found for @${user.login}.`);
    return writeDone(res);
  }
  const lines = [`Recent transactions for @${user.login}:\n`];
  rows.forEach((tx, i) => {
    const amt = tx.amountIn ? `${tx.amountIn} ${tx.tokenIn ?? ""}` : "";
    const link = tx.txHash ? `\n     https://basescan.org/tx/${tx.txHash}` : "";
    lines.push(`  ${i + 1}. ${(tx.type ?? "unknown").padEnd(18)} ${amt}${link}`);
  });
  writeChunk(res, lines.join("\n"));
  writeDone(res);
}

async function handleDeposit(res: Response, intent: ParsedIntent, user: GitHubUser) {
  if (!intent.amount || !intent.token_in) {
    writeChunk(res, "Please specify amount and token.\nExample: @gitbankbot deposit 50 USDC");
    return writeDone(res);
  }
  const code = await createPendingRecord(user.login, "deposit", {
    amount: intent.amount,
    token: intent.token_in.toUpperCase(),
  });
  writeChunk(res, confirmMsg(code, `Deposit queued: ${intent.amount} ${intent.token_in.toUpperCase()}`));
  writeDone(res);
}

async function handleWithdraw(res: Response, intent: ParsedIntent, user: GitHubUser) {
  if (!intent.amount || !intent.token_in) {
    writeChunk(res, "Please specify amount and token.\nExample: @gitbankbot withdraw 50 USDC to 0x1234...");
    return writeDone(res);
  }
  const code = await createPendingRecord(user.login, "withdraw", {
    amount: intent.amount,
    token: intent.token_in.toUpperCase(),
    to_address: intent.recipient ?? "",
  });
  const dest = intent.recipient ? ` to ${intent.recipient}` : "";
  writeChunk(res, confirmMsg(code, `Withdraw queued: ${intent.amount} ${intent.token_in.toUpperCase()}${dest}`));
  writeDone(res);
}

async function handleSwap(res: Response, intent: ParsedIntent, user: GitHubUser) {
  if (!intent.amount || !intent.token_in || !intent.token_out) {
    writeChunk(res, "Please specify amount and token pair.\nExample: @gitbankbot swap 10 USDC to WETH");
    return writeDone(res);
  }
  const code = await createPendingRecord(user.login, "swap", {
    amount: intent.amount,
    from_token: intent.token_in.toUpperCase(),
    to_token: intent.token_out.toUpperCase(),
  });
  writeChunk(res, confirmMsg(code, `Swap queued: ${intent.amount} ${intent.token_in.toUpperCase()} to ${intent.token_out.toUpperCase()}`));
  writeDone(res);
}

async function handleTransfer(res: Response, intent: ParsedIntent, user: GitHubUser) {
  if (!intent.amount || !intent.token_in || !intent.recipient) {
    writeChunk(res, "Please specify amount, token, and recipient.\nExample: @gitbankbot send 10 USDC to @alice");
    return writeDone(res);
  }
  const code = await createPendingRecord(user.login, "withdraw", {
    amount: intent.amount,
    token: intent.token_in.toUpperCase(),
    to_address: intent.recipient,
  });
  writeChunk(res, confirmMsg(code, `Transfer queued: ${intent.amount} ${intent.token_in.toUpperCase()} to ${intent.recipient}`));
  writeDone(res);
}

async function handleLaunchToken(res: Response, intent: ParsedIntent, user: GitHubUser) {
  if (!intent.token_name || !intent.token_symbol) {
    writeChunk(res, "Please specify token name and symbol.\nExample: @gitbankbot launch token DevFund symbol DEV");
    return writeDone(res);
  }
  const code = await createPendingRecord(user.login, "launch_token", {
    name: intent.token_name,
    symbol: intent.token_symbol.toUpperCase(),
    description: intent.token_description ?? "",
  });
  writeChunk(res, confirmMsg(code, `Token launch queued: "${intent.token_name}" (${intent.token_symbol.toUpperCase()})`));
  writeDone(res);
}

async function handleConfirmCheck(res: Response, code: string, user: GitHubUser) {
  const [row] = await db.select().from(mcpPendingTable).where(eq(mcpPendingTable.confirmCode, code)).limit(1);
  if (!row) {
    writeChunk(res, `Confirm code "${code}" not found. It may have expired or already been used.`);
    return writeDone(res);
  }
  if (row.githubUsername.toLowerCase() !== user.login.toLowerCase()) {
    writeChunk(res, `This command was requested by @${row.githubUsername}. Only they can confirm it.`);
    return writeDone(res);
  }
  if (row.status === "executed") {
    writeChunk(res, `Already executed.\n${row.resultText ?? ""}`);
    return writeDone(res);
  }
  if (row.status !== "pending" || new Date() > row.expiresAt) {
    writeChunk(res, `This confirm code has ${row.status === "pending" ? "expired" : row.status}. Please run the request again.`);
    return writeDone(res);
  }
  writeChunk(res, `Confirm code verified. Open:\n${CONFIRM_URL}\n\nAnd post:\n@gitbankbot confirm ${code}`);
  writeDone(res);
}

function handleHelp(res: Response, login: string) {
  writeChunk(res, `Gitbank vault commands for @${login}:

Read (instant, no confirmation):
  @gitbankbot balance
  @gitbankbot history

Write (queues a confirm code, authorize on GitHub):
  @gitbankbot deposit 100 USDC
  @gitbankbot withdraw 50 USDC to 0x1234...
  @gitbankbot swap 10 USDC to WETH
  @gitbankbot send 20 USDC to @alice
  @gitbankbot launch token DevFund symbol DEV

After every write command, click the link provided and post one comment to authorize.
Your GitHub account (YubiKey, passkey, 2FA) is the only auth that matters.

Vault: https://gitbank.io`);
  writeDone(res);
}

// ── Main route ────────────────────────────────────────────────────────────────

router.post("/copilot", async (req, res) => {
  const ghToken = (req.headers["x-github-token"] as string | undefined) ?? "";

  if (!ghToken) {
    res.status(401).json({ error: "Missing X-GitHub-Token header" });
    return;
  }

  const ghUser = await verifyGitHubToken(ghToken);
  if (!ghUser) {
    res.status(401).json({ error: "Could not verify GitHub identity" });
    return;
  }

  type CopilotMsg = { role: string; content: string | { type?: string; text?: string }[] };
  const messages = (req.body?.messages as CopilotMsg[] | undefined) ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const rawContent =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : (lastUser?.content as { text?: string }[] | undefined)?.map((c) => c.text ?? "").join(" ") ?? "";

  const command = rawContent.replace(/@gitbankbot\s*/gi, "").trim();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as unknown as { flushHeaders: () => void }).flushHeaders();
  }

  try {
    const confirmMatch = command.match(/^confirm\s+(mcp[0-9a-f]+)$/i);
    if (confirmMatch) {
      await handleConfirmCheck(res, confirmMatch[1]!.toLowerCase(), ghUser);
      return;
    }

    if (!command || /^(help|hi|hello|\?|commands)$/i.test(command)) {
      handleHelp(res, ghUser.login);
      return;
    }

    if (/^(balance|bal|balances)$/i.test(command)) {
      await handleBalance(res, ghUser);
      return;
    }

    if (/^(history|txs|transactions|tx)$/i.test(command)) {
      await handleHistory(res, ghUser);
      return;
    }

    const intent = await parseIntent(command);

    switch (intent.intent) {
      case "balance_check": await handleBalance(res, ghUser); break;
      case "history":       await handleHistory(res, ghUser); break;
      case "deposit":       await handleDeposit(res, intent, ghUser); break;
      case "withdraw":      await handleWithdraw(res, intent, ghUser); break;
      case "swap":          await handleSwap(res, intent, ghUser); break;
      case "transfer":      await handleTransfer(res, intent, ghUser); break;
      case "launch_token":  await handleLaunchToken(res, intent, ghUser); break;
      default:
        writeChunk(res, `Unknown command. Type "@gitbankbot help" to see all available commands.`);
        writeDone(res);
    }
  } catch (err) {
    logger.error({ err }, "copilot extension error");
    if (!res.headersSent) { res.status(500).json({ error: "Internal error" }); return; }
    writeChunk(res, "An error occurred. Please try again.");
    writeDone(res);
  }
});

export default router;
