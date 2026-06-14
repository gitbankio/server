# IBM AI Builders Challenge — Gitbank Submission

**Category**: Wildcard — Future of Work  
**Deadline**: July 31, 2026  
**Endpoint**: https://gitbank.io/api/mcp  
**Repo**: https://github.com/gitbankio/mcp

---

## BeMyApp Submission Form Text

### Project Name
Gitbank MCP

### Short tagline (160 chars max)
AI-powered treasury management for Web3 dev teams. IBM watsonx reads live on-chain data and executes vault operations via GitHub — zero gas, zero keys.

### What does your project do? (Problem + Solution, ~300 words)

Open-source Web3 teams have three completely disconnected workflows: they coordinate on GitHub Issues, they pay contributors in crypto, and they ask AI assistants questions about project health. Today those three never talk to each other.

Gitbank connects all three through an MCP server that gives IBM watsonx — and any MCP-compatible AI — real-time read and write access to on-chain team treasuries.

**Read tools** return live on-chain data instantly:
- Get vault balance (WETH, USDC locked on Base mainnet)
- Get transaction history (deposits, withdrawals, swaps, bounty payouts)
- Get project budget status (total, spent, remaining, per-task)
- List connected GitHub repos

**Write tools** queue commands that require GitHub confirmation:
- Deposit, withdraw, swap tokens in the vault
- Assign bounties to contributors
- Launch tokens via the MCP-exclusive launchpad

A team PM asks IBM watsonx: "Are we on budget for Q3 Sprint?" The AI calls `get_project_status`, gets live on-chain data, and responds: "Q3 Sprint: 500 USDC total, 320 spent (64%), 180 remaining. 3 tasks paid out, 5 open. Last payout: 50 USDC to @contributor on PR #89."

Write operations are protected by GitHub account security. The AI queues a command and returns a confirm code. The user posts the code in a GitHub discussion — verified by GitHub's signed webhook (HMAC-SHA256). No private key exposure, no wallet plugin, no gas.

### What IBM technology did you use?

IBM watsonx.ai (Bob). The Gitbank MCP server connects to IBM watsonx.ai via the MCP protocol (StreamableHTTP, stateless). Once configured, watsonx can call all 10 Gitbank tools directly — querying live Base mainnet data, managing vault operations, tracking project budgets — all from natural language.

### GitHub / repo link
https://github.com/gitbankio/mcp

### Demo video link
[TO BE ADDED after recording]

### Team name
Gitbank

### Team member(s)
[Add your name and IBM SkillsBuild profile link here]

### IBM SkillsBuild course completed
[Paste your SkillsBuild completion badge URL here]

---

## Video Script — 3 Minutes

**[0:00 — 0:20] Hook**

"Open-source teams manage budgets in spreadsheets, pay contributors manually, and have no way to ask AI what's actually happening on-chain. Gitbank changes that."

Show: gitbank.io landing page.

**[0:20 — 0:50] What is Gitbank**

"Gitbank gives Web3 dev teams a soul-bound vault on Base L2, anchored to their GitHub ID. All operations run via @gitbankbot mentions in GitHub Issues and PRs — deposit, withdraw, swap, assign bounties, auto-payout on PR merge. The relayer pays all gas. Contributors pay zero."

Show: brief clip of a GitHub issue with @gitbankbot commands.

**[0:50 — 1:30] MCP server — the IBM angle**

"Now Gitbank has an MCP server. Connect IBM watsonx.ai to https://gitbank.io/api/mcp and it gets 10 tools — 5 read, 5 write."

Show: IBM watsonx.ai with Gitbank MCP configured.

Type in watsonx: "What is the vault balance for teamgitbank?"

Show: AI calls `get_vault_balance`, returns live on-chain balance.

Type in watsonx: "Show me the Q3 Sprint project status."

Show: AI calls `get_project_status`, returns budget breakdown.

**[1:30 — 2:00] Write tools + GitHub confirm flow**

"Write tools are protected by GitHub. Ask watsonx to assign a bounty — it returns a confirm code. You paste that code in a GitHub discussion. The bot verifies your GitHub identity via signed webhook and executes the transaction. No private key, no wallet, no gas."

Show: watsonx returns confirm code. User posts it on GitHub. Bot replies with transaction receipt.

**[2:00 — 2:30] MCP Launchpad (new MCP-exclusive feature)**

"MCP clients also get an exclusive feature: token launch. Ask watsonx to launch a token, send 0.01 ETH to the treasury, confirm on GitHub — Gitbank deploys the token via Clanker, buys it with your ETH, and distributes it to all $GITBANK holders automatically. Then tweets the launch mentioning which AI you used."

Show: `request_launch_token` call, resulting tweet.

**[2:30 — 3:00] Close**

"Gitbank + IBM watsonx is the Future of Work for Web3 teams: AI reads your on-chain treasury in real time, executes operations through GitHub identity, and pays contributors automatically when PRs merge."

"MCP server live at gitbank.io/api/mcp. Apache-2.0."

Show: gitbank.io URL, GitHub repo.

---

## User Action Checklist

Things you must do personally before July 31, 2026:

### 1. IBM SkillsBuild course
- Go to https://skillsbuild.org
- Search "Generative AI" or "watsonx"
- Complete at least one IBM AI course and earn the badge
- Copy the badge URL for the submission form

### 2. Register on BeMyApp
- Go to https://ibm-ai-builders-challenge.bemyapp.com (or the IBM challenge page)
- Create an account or log in
- Register your project

### 3. Record the demo video (3 min max)
- Use the script above
- Show: watsonx configured with gitbank MCP, live tool calls, GitHub confirm flow
- Upload to YouTube (unlisted is fine) or Google Drive
- Paste the link into the BeMyApp submission form

### 4. Fill out the BeMyApp form
- Use the text from the "BeMyApp Submission Form Text" section above
- Add your real name and IBM SkillsBuild badge URL
- Add the demo video link
- Submit before July 31, 2026

### 5. Push the MCP repo (needs your confirmation — say "yes" to run)
Run: `node scripts/push-repos.mjs mcp`
(Will push lib/mcp to https://github.com/gitbankio/mcp with clean commit history)

### 6. Optional: share on social
- Tweet from @gitbankio: "We submitted to the IBM AI Builders Challenge. Gitbank MCP gives @IBMwatsonx live on-chain treasury access for Web3 teams. gitbank.io/api/mcp"
- Tag IBM and BeMyApp

---

## IBM watsonx.ai Setup Instructions (for the demo)

Add to watsonx MCP config:

```json
{
  "mcpServers": {
    "gitbank": {
      "type": "http",
      "url": "https://gitbank.io/api/mcp"
    }
  }
}
```

Test prompts:
- "What is the vault balance for teamgitbank?"
- "Show me the last 5 transactions for teamgitbank."
- "What is the project status for the Q3 Sprint under teamgitbank?"

---

## Key facts for the submission

| Field | Value |
|-------|-------|
| MCP endpoint | https://gitbank.io/api/mcp |
| Protocol | MCP StreamableHTTP (stateless, protocol 2025-03-26) |
| Tools | 10 (5 read, 5 write) |
| Chain | Base Mainnet (chainId 8453) |
| Identity anchor | GitHub Permanent User ID |
| Gas model | Relayer pays all gas — users pay zero |
| License | Apache-2.0 |
| Repo | https://github.com/gitbankio/mcp |
| Factory contract | 0xAA0a4ff46733EBaE8E658642A1314f18980fc77B |
| Basescan | https://basescan.org/address/0xAA0a4ff46733EBaE8E658642A1314f18980fc77B |
