# IBM AI Builders Challenge — BeMyApp Submission

Challenge: IBM AI Builders Challenge
Category: Wildcard — Future of Work
Deadline: July 31, 2026

---

## PROJECT NAME

Gitbank MCP

---

## TAGLINE (160 chars)

Give IBM watsonx real-time read and write access to on-chain team treasuries. Budget checks, bounty assignments, swaps — all from a conversation.

---

## SHORT DESCRIPTION

Gitbank MCP connects IBM watsonx.ai to on-chain vault data on Base mainnet. Teams can ask "are we on budget?" and get a live answer backed by real on-chain state. Write operations require a signed GitHub comment to execute, so hardware 2FA protects every transaction.

---

## LONG DESCRIPTION

### The problem

Open-source Web3 teams coordinate through GitHub. They pay contributors in crypto. They run project budgets on Base L2.

When a PM opens an AI assistant and asks "are we on budget for this sprint?" — the AI has no idea. On-chain data is invisible. Vault state is a black box. Three workflows (GitHub, on-chain treasury, AI) are completely disconnected.

### What we built

Gitbank is an IssueOps platform for Web3 dev teams. Three parts:

**1. Soul-bound vault on Base mainnet**
A smart vault per GitHub user. Holds USDC and WETH. Anchored to a permanent GitHub user ID. Deployed via EIP-1167 minimal proxy factory. Verified on Basescan.

**2. GitHub bot (@gitbankbot)**
All operations run via @gitbankbot mentions in Issues and PRs. Lock assets, assign bounties, swap tokens, auto-pay on PR merge. Claude Haiku parses natural-language commands. Relayer pays all gas — contributors pay zero ETH.

**3. MCP server at gitbank.io/api/mcp**
A live MCP endpoint compatible with IBM watsonx.ai and any MCP client. Ten tools auto-discovered on first connect.

Read tools return live on-chain data instantly:
- get_vault_balance — USDC and WETH locked in a user's vault
- get_transactions — recent deposits, withdrawals, swaps, bounty payouts
- get_project_status — budget total, spent, remaining, per-task bounty status
- list_repos — connected GitHub repos
- check_pending — poll a pending write command

Write tools queue a command and return a confirm_code. The user posts the code in a GitHub comment to authorize. GitHub account security (YubiKey, passkey, hardware 2FA) protects every vault operation.

### IBM watsonx integration

Connect in one config line:

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

Ask watsonx: "Brief me on the Q3 Sprint budget before standup."

It calls get_project_status and responds: "Q3 Sprint: 500 USDC total, 320 spent (64%), 180 remaining. 8 tasks, 3 paid out."

Every answer is backed by live on-chain data.

### Why this is the Future of Work

Remote, async, crypto-native teams are a growing reality. They need AI that can act inside their actual workflow.

Gitbank gives IBM watsonx a live connection to on-chain treasury state. For the first time, an AI assistant can answer: "How much have we paid out this month? Who is the top contributor? Are we on track?"

Write operations require a signed GitHub comment — AI proposes, humans confirm. Hardware keys protect every vault change.

---

## IBM TECHNOLOGY USED

IBM watsonx.ai connected via MCP (Model Context Protocol, streamable HTTP transport).

---

## LINKS

- GitHub: https://github.com/gitbankio/mcp
- Website: https://gitbank.io
- MCP endpoint: https://gitbank.io/api/mcp
- Contract (Base Mainnet): 0xAA0a4ff46733EBaE8E658642A1314f18980fc77B
- Basescan: https://basescan.org/address/0xAA0a4ff46733EBaE8E658642A1314f18980fc77B#code

---

## TEAM

teamgitbank

## LICENSE

Apache 2.0
