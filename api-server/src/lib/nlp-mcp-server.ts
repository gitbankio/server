/**
 * NLP MCP Server — single "gitbank" tool that accepts natural language.
 * Designed for AI clients with weak tool-calling (e.g. NousResearch Hermes).
 * The NLP processing happens server-side via Claude — the client only
 * needs to call ONE tool with a plain text message.
 *
 * Endpoint: /api/mcp/hermes   (separate from the existing /api/mcp)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import {
  handleGetVaultBalance,
  handleGetTransactions,
  handleGetProjectStatus,
  handleListStocks,
  handleGetStockPrice,
  handleGetRwaPortfolio,
  handleCheckPending,
  createPending,
} from "@workspace/mcp";

const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

// ── Intent system prompt (mirrors webhook.ts) ─────────────────────────────────

const INTENT_SYSTEM_PROMPT = `You are the Gitbank intent parser. Extract structured intent from a user message.

The user is chatting with an AI assistant that has the Gitbank MCP tool. Extract their intent and return ONLY valid JSON.

Supported intents:
Personal vault: deposit, withdraw, swap, transfer, balance_check, history, help, cancel
Project workspace: create_project, assign_bounty, project_status
Token launch: launch_token
RWA stocks: buy_stock, sell_stock, rwa_portfolio, stock_price, list_stocks
Other: unknown

Return JSON with this exact shape:
{
  "intent": "<intent string>",
  "token_in": "<USDC|WETH|null>",
  "token_out": "<USDC|WETH|null>",
  "amount": <number or null>,
  "recipient": "<0xaddress or null>",
  "to_github_username": "<GitHub username without @ or null>",
  "project_name": "<string or null>",
  "issue_id": <number or null>,
  "contributor": "<GitHub username without @ or null>",
  "ticker": "<uppercase stock ticker or null>",
  "confidence": <0.0 to 1.0>
}

Notes:
- ETH and WETH both map to "WETH"
- For "check balance", "my balance", "how much do I have": intent="balance_check"
- For "transactions", "history", "recent activity": intent="history"
- For "list stocks", "what stocks": intent="list_stocks"
- For "price of NVDA", "AAPL price", "how much is TSLA": intent="stock_price", ticker="NVDA"
- For "my stocks", "my portfolio", "rwa portfolio": intent="rwa_portfolio"
- For "buy NVDA", "buy 100 USDC of AAPL": intent="buy_stock", ticker="NVDA", amount=<usdc amount>
- For "sell NVDA", "sell 1 AAPL": intent="sell_stock", ticker="NVDA", amount=<stock amount>
- For "send 10 USDC to @alice": intent="transfer", token_in="USDC", amount=10, to_github_username="alice"
- For "withdraw 50 USDC to 0x1234...": intent="withdraw", token_in="USDC", amount=50, recipient="0x1234..."
- to_github_username is for transfers to other GitHub users (no @ prefix). recipient is for 0x wallet addresses.
- Return ONLY the JSON object. No explanation, no markdown.`;

interface ParsedIntent {
  intent: string;
  token_in: string | null;
  token_out: string | null;
  amount: number | null;
  recipient: string | null;
  to_github_username: string | null;
  project_name: string | null;
  issue_id: number | null;
  contributor: string | null;
  ticker: string | null;
  confidence: number;
}

async function parseIntent(message: string): Promise<ParsedIntent> {
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 256,
    system: INTENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: message }],
  });
  const raw  = resp.content[0]?.type === "text" ? resp.content[0].text : "{}";
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(text) as ParsedIntent;
  } catch {
    return {
      intent: "unknown", token_in: null, token_out: null, amount: null,
      recipient: null, to_github_username: null, project_name: null,
      issue_id: null, contributor: null, ticker: null, confidence: 0,
    };
  }
}

function mcpText(obj: unknown) {
  return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

const CONFIRM_INSTRUCTIONS = (code: string, username: string) =>
  `Step 1 — Open: https://github.com/gitbankio/playground/discussions/4#new_comment_form\n\n` +
  `Step 2 — Post this comment:\n\n@gitbankbot confirm ${code}\n\nExpires in 10 min. Only @${username} can confirm.`;

// ── NLP handler ───────────────────────────────────────────────────────────────

async function handleGitbankNlp(args: { message: string; github_username: string }) {
  const { message, github_username } = args;

  let intent: ParsedIntent;
  try {
    intent = await parseIntent(message);
  } catch {
    return mcpText("Could not parse intent. Please try again.");
  }

  if (intent.confidence < 0.5) {
    return mcpText(
      `I didn't quite understand that. Try something like:\n` +
      `- "check my balance"\n- "swap 10 USDC to WETH"\n- "list available stocks"\n- "buy 50 USDC of NVDA"\n- "my transaction history"`,
    );
  }

  // ── Read intents — execute immediately ────────────────────────────────────

  switch (intent.intent) {
    case "balance_check":
      return handleGetVaultBalance({ github_username });

    case "history":
      return handleGetTransactions({ github_username, limit: 10 });

    case "rwa_portfolio":
      return handleGetRwaPortfolio({ github_username });

    case "project_status":
      if (!intent.project_name) return mcpText("Which project? Please include the project name.");
      return handleGetProjectStatus({ github_username, project_name: intent.project_name });

    case "list_stocks":
      return handleListStocks();

    case "stock_price":
      if (!intent.ticker) return mcpText("Which stock ticker? e.g. 'price of NVDA'");
      return handleGetStockPrice({ ticker: intent.ticker });

    case "help":
      return mcpText(
        `Gitbank commands you can use:\n\n` +
        `READ (instant):\n` +
        `- "check my balance"\n` +
        `- "my transaction history"\n` +
        `- "list available stocks"\n` +
        `- "price of NVDA"\n` +
        `- "my stock portfolio"\n\n` +
        `WRITE (returns a confirm code to post on GitHub):\n` +
        `- "deposit 10 USDC"\n` +
        `- "withdraw 5 USDC to 0x..."\n` +
        `- "swap 10 USDC to WETH"\n` +
        `- "send 10 USDC to alice"\n` +
        `- "buy 50 USDC of NVDA"\n` +
        `- "sell 1 NVDA"`,
      );

    // ── Write intents — return confirm_code ──────────────────────────────────

    case "deposit": {
      if (!intent.amount || !intent.token_in)
        return mcpText("Please include amount and token. e.g. 'deposit 10 USDC'");
      const code = await createPending(github_username, "deposit", {
        amount: intent.amount,
        token: intent.token_in,
      });
      return mcpText({ status: "pending", confirm_code: code, command: `deposit ${intent.amount} ${intent.token_in}`, instructions: CONFIRM_INSTRUCTIONS(code, github_username) });
    }

    case "withdraw": {
      if (!intent.amount || !intent.token_in)
        return mcpText("Please include amount, token, and destination address. e.g. 'withdraw 5 USDC to 0x...'");
      if (!intent.recipient)
        return mcpText("Please include a destination wallet address (0x...). e.g. 'withdraw 5 USDC to 0x1234...'");
      const code = await createPending(github_username, "withdraw", {
        amount: intent.amount,
        token: intent.token_in,
        to_address: intent.recipient,
      });
      return mcpText({ status: "pending", confirm_code: code, command: `withdraw ${intent.amount} ${intent.token_in} to ${intent.recipient}`, instructions: CONFIRM_INSTRUCTIONS(code, github_username) });
    }

    case "swap": {
      if (!intent.amount || !intent.token_in || !intent.token_out)
        return mcpText("Please include amount, from token, and to token. e.g. 'swap 10 USDC to WETH'");
      const code = await createPending(github_username, "swap", {
        amount: intent.amount,
        from_token: intent.token_in,
        to_token: intent.token_out,
      });
      return mcpText({ status: "pending", confirm_code: code, command: `swap ${intent.amount} ${intent.token_in} to ${intent.token_out}`, instructions: CONFIRM_INSTRUCTIONS(code, github_username) });
    }

    case "transfer": {
      if (!intent.amount || !intent.token_in)
        return mcpText("Please include amount, token, and recipient GitHub username. e.g. 'send 10 USDC to alice'");
      if (!intent.to_github_username)
        return mcpText("Please include the recipient GitHub username. e.g. 'send 10 USDC to alice'");
      const code = await createPending(github_username, "transfer", {
        amount: intent.amount,
        token: intent.token_in,
        to_github_username: intent.to_github_username,
      });
      return mcpText({ status: "pending", confirm_code: code, command: `send ${intent.amount} ${intent.token_in} to @${intent.to_github_username}`, instructions: CONFIRM_INSTRUCTIONS(code, github_username) });
    }

    case "buy_stock": {
      if (!intent.ticker || !intent.amount)
        return mcpText("Please include ticker and USDC amount. e.g. 'buy 50 USDC of NVDA'");
      const code = await createPending(github_username, "buy_stock", {
        ticker: intent.ticker.toUpperCase(),
        usdc_amount: intent.amount,
      });
      return mcpText({ status: "pending", confirm_code: code, command: `buy ${intent.amount} USDC of ${intent.ticker.toUpperCase()}`, instructions: CONFIRM_INSTRUCTIONS(code, github_username) });
    }

    case "sell_stock": {
      if (!intent.ticker || !intent.amount)
        return mcpText("Please include ticker and amount to sell. e.g. 'sell 1 NVDA'");
      const code = await createPending(github_username, "sell_stock", {
        ticker: intent.ticker.toUpperCase(),
        amount: intent.amount,
      });
      return mcpText({ status: "pending", confirm_code: code, command: `sell ${intent.amount} ${intent.ticker.toUpperCase()}`, instructions: CONFIRM_INSTRUCTIONS(code, github_username) });
    }

    default:
      return mcpText(
        `Unknown command: "${intent.intent}". Type "help" to see what I can do.`,
      );
  }
}

// ── Server factory ────────────────────────────────────────────────────────────

export function createNlpMcpServer(): McpServer {
  const server = new McpServer({
    name: "gitbank-hermes",
    version: "0.1.0",
  });

  server.tool(
    "gitbank",
    `Send any Gitbank command in plain natural language. Examples: "check my balance", "swap 10 USDC to WETH", "list available stocks", "buy 50 USDC of NVDA", "my transaction history". The github_username is required for all commands.`,
    {
      message: z.string().describe("Your Gitbank command in plain language. Any language accepted."),
      github_username: z.string().describe("Your GitHub username (without @)"),
    },
    { title: "Gitbank" },
    handleGitbankNlp,
  );

  server.tool(
    "check_pending",
    "Check the status of a pending Gitbank command by its confirm_code.",
    { confirm_code: z.string().describe("The confirm_code returned by a previous gitbank command") },
    { title: "Check Pending", readOnlyHint: true },
    handleCheckPending,
  );

  return server;
}
