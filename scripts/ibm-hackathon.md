# IBM AI Builders Challenge - Submission Materials

Challenge: **Wildcard: Future of Work**
Deadline: **July 31, 2026**
Repo: **https://github.com/gitbankio/mcp**

---

## 1. BeMyApp Submission Form Text

### Project name
Gitbank MCP

### Team name
Gitbank

### One-line description (tweet-length)
Give IBM watsonx.ai live read/write access to your Web3 treasury on Base mainnet, secured by GitHub identity.

### Category
Wildcard: Future of Work

### Short description (200 words)
Gitbank MCP connects IBM watsonx.ai to on-chain vault data in real time. A PM can ask "are we on budget for Q3?" and get a live answer pulled from Base Mainnet, not a spreadsheet.

The server exposes 10 tools: 5 read-only (vault balance, transactions, project status, repos, pending status) and 5 write tools (deposit, withdraw, swap, assign bounty, launch token). Read tools return live blockchain data instantly. Write tools queue the command and return a confirm code. The user authorizes by posting one line in a GitHub Discussion. GitHub account security (YubiKey, hardware 2FA) protects every transaction.

No private keys leave the user's control. No gas cost for contributors. The relayer pays all gas. Soul-bound vaults on Base Mainnet are anchored to GitHub permanent user IDs, so they survive username renames and cannot be phished.

Open-source Web3 teams already coordinate through GitHub Issues and PRs. Gitbank makes their AI assistant aware of what is actually happening in their treasury, in real time.

### Long description / problem statement
Open-source Web3 teams face three disconnected workflows:

1. **On-chain treasury data** lives in a smart contract vault. Nobody can query it conversationally.
2. **Contributor bounties** are assigned and paid via GitHub bot comments. The data lives in a database that AI assistants cannot access.
3. **AI assistants** like IBM watsonx.ai have no visibility into what is actually happening in the team's on-chain budget.

Gitbank closes all three gaps with a single MCP endpoint at `https://gitbank.io/api/mcp`.

Once IBM Bob is connected via one JSON config block, any conversation in watsonx.ai can:
- Query live vault balances on Base Mainnet
- Retrieve recent transactions (deposits, withdrawals, swaps, bounty payouts)
- Check project budget status (total, spent, remaining, per-task breakdowns)
- Queue write operations (deposit, withdraw, swap, assign bounty, launch token) secured by GitHub identity

The confirm flow is key to why this is safe for AI-driven treasury operations: the AI assistant queues the command and returns a confirm code. The user authorizes by posting a single comment in a GitHub Discussion from their own account. GitHub's signed webhook infrastructure verifies the request. The relayer submits the transaction on-chain. No AI agent ever touches a private key.

### Demo URL
https://gitbank.io/mcp/watsonx

### GitHub repo
https://github.com/gitbankio/mcp

### Live MCP endpoint
https://gitbank.io/api/mcp

### Tech stack
- IBM watsonx.ai (MCP client, Agent Lab)
- Model Context Protocol (Streamable HTTP, stateless)
- Base L2 Mainnet (chainId 8453)
- viem (on-chain reads via Base RPC)
- GitHub App (identity verification via signed webhooks)
- PostgreSQL + Drizzle ORM (project/bounty data)
- Express 5 + Node.js 24

### Why Future of Work
Web3 open-source teams are the fastest-growing segment of distributed work. They need AI assistants that understand their real financial state, not just their chat history. Gitbank makes the on-chain treasury a first-class data source for any AI assistant, starting with IBM watsonx.ai.

---

## 2. Video Script (3 minutes)

### Visual notes
- Record screen: watsonx.ai Agent Lab + Gitbank MCP panel
- Show Basescan link when transaction confirms
- Keep pace slow, let the response text render fully before cutting

---

**[0:00 - 0:25] Hook**

> "What if your AI assistant could tell you exactly how much budget is left in your Q3 sprint, not from a spreadsheet, but from a live smart contract on Base Mainnet?"

Show: terminal output from curl /api/mcp returning 200 + server info

---

**[0:25 - 0:55] Setup (30 seconds)**

> "Setting up is one JSON block. Open IBM watsonx.ai Agent Lab, add an MCP server, paste the URL. Done. No API key, no installation."

Show: watsonx.ai Agent Lab UI. Add MCP server config:
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
Show: Gitbank MCP listed as "Connected" in Agent Lab

---

**[0:55 - 1:30] Read demo (35 seconds)**

> "Now I can ask watsonx about any Gitbank vault by GitHub username."

Type in Agent Lab: "What is the vault balance for GitHub user teamgitbank?"

Show: watsonx calls `get_vault_balance`. Response appears:
> "Vault balance for teamgitbank: 2.50 USDC, 0.0009 WETH locked on Base Mainnet. Vault address: 0x70Bf..."

Type: "Show the last 5 transactions for teamgitbank."

Show: `get_transactions` called. Response lists deposits, swap, bounty payout with tx hashes and Basescan links.

---

**[1:30 - 2:05] Write demo with confirm flow (35 seconds)**

> "Write tools work too, but they require GitHub authorization. No AI agent ever touches a private key."

Type: "Swap 10 USDC to WETH for user teamgitbank."

Show: watsonx calls `request_swap`. Returns:
> "Command queued. Confirm code: mcp3f9a12b4. To authorize, post this in the GitHub Discussion: @gitbankbot confirm mcp3f9a12b4 (expires in 10 minutes)"

Show: user opens GitHub Discussion, posts the comment. Bot replies: "Swap executed. 10 USDC in, 0.00449 WETH out. Tx: 0x..."

Type back in Agent Lab: "done". Watsonx calls `check_pending`. Shows tx hash + Basescan link.

---

**[2:05 - 2:35] Security + architecture (30 seconds)**

> "Here is why this is safe for treasury operations at any scale."

Show: diagram (or narrate over architecture section of README)

> "The vault is soul-bound to a GitHub permanent user ID. Write operations require a GitHub webhook event, signed by GitHub's servers with HMAC-SHA256. Even if someone steals the confirm code from your AI chat history, they cannot execute the transaction without posting from your authenticated GitHub account."

---

**[2:35 - 3:00] Call to action**

> "The MCP endpoint is live at gitbank.io/api/mcp. Open-source, Apache 2.0. Connect any MCP-compatible client in under a minute."

Show: gitbank.io/mcp page with watsonx setup card

> "This is what the future of work looks like. AI assistants with live access to on-chain data, secured by identity systems that already exist."

End on: gitbank.io

---

## 3. User Action Checklist (T006)

Things you must do personally that cannot be automated:

### Before July 31, 2026

- [ ] **Register on IBM BeMyApp**
  URL: https://ibmaidevelopers.bemyapp.com (or the challenge registration link from IBM)
  Create an account with your work/personal email.

- [ ] **Complete IBM SkillsBuild modules** (if required by the challenge rules)
  Check the official challenge page for prerequisites.
  Common required badge: "AI Fundamentals" on SkillsBuild

- [ ] **Push the MCP repo to GitHub** (confirm with "yes" to trigger push)
  Run: `node scripts/push-repos.mjs mcp`
  Repo: https://github.com/gitbankio/mcp must be public

- [ ] **Record the demo video** (3 min, use script above)
  Upload to YouTube (unlisted or public) or directly to BeMyApp.
  Paste the YouTube/video URL into the submission form.

- [ ] **Submit on BeMyApp**
  Fill the form using the text from Section 1 above.
  Paste the GitHub repo link and demo video link.
  Deadline: July 31, 2026 (confirm exact time in the challenge rules)

- [ ] **Keep the repo public** until judging is complete (typically 2-4 weeks after deadline)

### Optional but recommended

- [ ] Post on LinkedIn/X about the submission with #IBMAIBuilders
- [ ] Tag @IBM and @IBMwatsonx in the post
- [ ] Add a GitHub topic `ibm-ai-builders-challenge` to gitbankio/mcp

### During the challenge window

- [ ] Monitor gitbankio/mcp GitHub issues for judge questions
- [ ] Ensure `https://gitbank.io/api/mcp` stays live (the endpoint is their test surface)
- [ ] Check if any IBM judge tries to connect watsonx and has issues - respond within 24h

---

## 4. Submission Status

| Task | Status | Notes |
|------|--------|-------|
| lib/mcp package built | Done | lib/mcp/src, 10 tools |
| /api/mcp endpoint live | Done | 200 on POST + GET |
| MCP protocol version | Done | 2024-11-05, Streamable HTTP stateless |
| gitbank.io/mcp/watsonx page | Done | Setup guide, test prompts, troubleshooting |
| README in gitbankio/mcp | Done | IBM-focused, Apache 2.0 |
| BeMyApp text | Done | Section 1 above |
| Video script | Done | Section 2 above, 3 min |
| Push to gitbankio/mcp | Pending | Run: node scripts/push-repos.mjs mcp (confirm first) |
| BeMyApp registration | Pending | User action |
| Video recording | Pending | User action |
| BeMyApp submission | Pending | User action, deadline July 31 |
