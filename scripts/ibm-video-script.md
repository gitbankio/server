# IBM AI Builders Challenge — Video Script (3 min)

---

## [0:00 - 0:30] THE PROBLEM

**Narasi:**

Open-source Web3 teams run on GitHub. They pay contributors in crypto. They track project budgets on-chain.

But when a PM opens IBM watsonx and types "are we on budget for Q3?" — the AI has no idea. On-chain data is invisible. The vault is a black box.

That gap is what Gitbank solves.

---

## [0:30 - 1:00] WHAT GITBANK IS

**Narasi:**

Gitbank is an IssueOps platform for Web3 dev teams.

- A soul-bound vault on Base mainnet holds the team treasury. Anchored to GitHub user IDs, not wallet keys.
- A GitHub bot executes every command: deposit, withdraw, swap, assign bounty, pay out on PR merge.
- An MCP server at `gitbank.io/api/mcp` gives any AI assistant real-time read and write access to the vault.

No install. No browser extension. Just one URL.

---

## [1:00 - 2:00] LIVE DEMO

**Screen: Open IBM watsonx / any MCP client, connect to gitbank.io/api/mcp**

**Narasi:**

I connect IBM watsonx to Gitbank with one config line: URL is `gitbank.io/api/mcp`. Ten tools are auto-discovered.

I type: "What is the vault balance for teamgitbank?"

watsonx calls `get_vault_balance`. It resolves the GitHub username to a permanent user ID, queries the Base mainnet contract — and returns: USDC balance, WETH balance, vault address, Basescan link.

**Screen: get_project_status call**

Now I ask: "How is the Q3 Sprint project doing?"

watsonx calls `get_project_status`. It returns: total budget, amount spent, remaining, every task with bounty status and contributor.

**Screen: request_deposit call**

Now a write operation. I type: "Deposit 10 USDC into the vault for teamgitbank."

watsonx calls `request_deposit`. It returns a confirm code and a GitHub link.

I click the link, post one comment: `@gitbankbot confirm mcp-abc123`.

The bot verifies my GitHub identity via signed webhook — HMAC-SHA256, not a password — and executes the deposit on Base mainnet.

I type "done" in watsonx. It calls `check_pending` and confirms: status executed, transaction hash, Basescan link.

No private key ever left my computer. The only thing that authorized this transaction was my GitHub account.

---

## [2:00 - 2:30] WHY THIS IS THE FUTURE OF WORK

**Narasi:**

Remote, async, crypto-native teams are already a reality. They need AI that can act inside their actual workflow — not just summarize a spreadsheet.

Gitbank gives IBM watsonx a live connection to on-chain treasury state. The AI can read budget health, transaction history, bounty assignments, all in real time.

And write operations are safe. GitHub confirmation means: even if your AI chat is compromised, nobody can drain your vault. YubiKey and passkeys protect every state change.

---

## [2:30 - 3:00] CALL TO ACTION

**Narasi:**

Gitbank MCP is live today at `gitbank.io/api/mcp`.

Connect any MCP-compatible AI assistant in under 60 seconds. No install, no API key, no registration.

GitHub: `github.com/gitbankio/mcp`

The vault contract is deployed and verified on Base mainnet. Apache 2.0. Open source.

This is what AI-native treasury management looks like.

---

## SCREEN RECORDING CHECKLIST

- [ ] Show IBM watsonx config screen with gitbank URL
- [ ] `get_vault_balance` call + response (USDC / WETH balances)
- [ ] `get_project_status` call + response (budget breakdown)
- [ ] `request_deposit` call + confirm code in response
- [ ] GitHub discussion page, post `@gitbankbot confirm <code>`
- [ ] `check_pending` call + `status: "executed"` + tx hash
- [ ] Basescan link open in browser

---

**Total: ~3 min**
