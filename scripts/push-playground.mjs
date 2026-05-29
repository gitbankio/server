#!/usr/bin/env node
/**
 * push-playground.mjs
 * Pushes README, COMMANDS, LICENSE to gitbankio/playground
 * and creates a welcome Discussion via GitHub GraphQL API.
 *
 * Usage:
 *   node scripts/push-playground.mjs
 */

import { execSync }                                     from "child_process";
import { rmSync, mkdirSync, writeFileSync }             from "fs";
import { createSign }                                   from "crypto";
import { tmpdir }                                       from "os";
import { join }                                         from "path";

// ── PEM normalizer ─────────────────────────────────────────────────────────────

function normalizePem(raw) {
  if (!raw) return "";
  let pem = raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (pem.includes("\n")) return pem;
  const match = pem.match(/-----BEGIN ([^-]+)-----\s*([\s\S]+?)\s*-----END \1-----/);
  if (!match) throw new Error("Invalid PEM: could not find BEGIN/END markers");
  const type = match[1];
  const b64  = match[2].replace(/\s+/g, "");
  const body = (b64.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----\n`;
}

// ── Config ─────────────────────────────────────────────────────────────────────

const APP_ID = process.env.GITHUB_APP_ID;
const PEM    = normalizePem(process.env.GITHUB_APP_PEM ?? "");
const ORG    = process.env.GITHUB_ORG ?? "gitbankio";
const REPO   = "playground";

const GIT_AUTHOR_NAME  = "teamgitbank";
const GIT_AUTHOR_EMAIL = "285689409+teamgitbank@users.noreply.github.com";
const GIT_ENV = [
  `GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME}"`,
  `GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL}"`,
  `GIT_COMMITTER_NAME="${GIT_AUTHOR_NAME}"`,
  `GIT_COMMITTER_EMAIL="${GIT_AUTHOR_EMAIL}"`,
].join(" ");

if (!APP_ID || !PEM) {
  console.error("GITHUB_APP_ID and GITHUB_APP_PEM are required.");
  process.exit(1);
}

// ── GitHub App auth ────────────────────────────────────────────────────────────

function makeJwt(appId, pem) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString("base64url");
  const data    = `${header}.${payload}`;
  const sign    = createSign("RSA-SHA256");
  sign.update(data);
  return `${data}.${sign.sign({ key: pem, format: "pem", type: "pkcs1" }, "base64url")}`;
}

async function getInstallationToken(jwt, org) {
  const listRes = await fetch("https://api.github.com/app/installations?per_page=100", {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
  });
  if (!listRes.ok) throw new Error(`list installations failed: ${await listRes.text()}`);
  const installations = await listRes.json();
  const inst = installations.find(
    (i) => i.account?.login?.toLowerCase() === org.toLowerCase()
  );
  if (!inst) {
    const accounts = installations.map((i) => i.account?.login).join(", ");
    throw new Error(`No installation found for "${org}". App installed on: [${accounts || "none"}]`);
  }
  const tokRes = await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
  });
  if (!tokRes.ok) throw new Error(`get token failed: ${await tokRes.text()}`);
  const { token } = await tokRes.json();
  return token;
}

// ── GraphQL helper ─────────────────────────────────────────────────────────────

async function gql(token, query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ── Shell helpers ──────────────────────────────────────────────────────────────

function run(cmd, cwd) {
  const safe = cmd.replace(/x-access-token:[^@]+@/, "x-access-token:***@");
  console.log(`  $ ${safe}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

function tryRun(cmd, cwd) {
  try { run(cmd, cwd); } catch { /* ignore */ }
}

function commitAll(message, cwd) {
  tryRun("git add .", cwd);
  const staged = execSync("git diff --cached --name-only", { cwd }).toString().trim();
  if (!staged) return;
  run(`${GIT_ENV} git commit -m "${message}"`, cwd);
}

// ── File content ───────────────────────────────────────────────────────────────

const README = `# Gitbank Playground

Test the Gitbank bot here. Run real commands on Base Sepolia testnet with no real money involved.

> **Testnet only.** Tokens in this environment have no monetary value. Safe to experiment freely.

---

## What is Gitbank?

Gitbank is an AI-powered IssueOps platform for Web3 teams. All vault operations run via bot mentions
in GitHub Issues, PRs, and Discussions. No wallet popups, no gas fees for users.

- Vault on Base L2 anchored to your GitHub permanent user ID
- Soul-bound gitTokens as locked position certificates
- Natural language commands in any language
- Bot replies with a plain-English receipt and Basescan link

---

## Quick start

**Step 1: Just mention the bot**

Open any Issue or Discussion in this repo and write a comment mentioning \`@gitbankbot\`.
The bot will deploy your vault automatically on your first command. No DApp visit required.

**Step 2: Get testnet tokens**

You need testnet USDC or WETH on Base Sepolia. Free faucets:
- [USDC faucet](https://faucet.circle.com) (select Base Sepolia)
- [Base Sepolia ETH faucet](https://www.alchemy.com/faucets/base-sepolia) (then wrap to WETH at app.uniswap.org)

**Step 3: Run a command**

Write a comment mentioning \`@gitbankbot\` in any Issue or Discussion:

\`\`\`
@gitbankbot deposit 10 USDC
\`\`\`

The bot reads your comment, executes the transaction, and replies with a receipt.

---

## Example commands

\`\`\`
@gitbankbot balance
@gitbankbot deposit 10 USDC
@gitbankbot deposit 0.005 WETH
@gitbankbot withdraw 5 USDC to 0xYourWalletAddress
@gitbankbot swap 0.001 WETH to USDC
@gitbankbot help
@gitbankbot cancel
\`\`\`

Commands work in any language. The bot replies in English.

---

## Full command reference

See [COMMANDS.md](COMMANDS.md) for the complete list including project workspace commands.

---

## Links

- Website: [gitbank.io](https://gitbank.io)
- Docs: [gitbank.io/docs](https://gitbank.io/docs)
- Dashboard: [gitbank.io/app/dashboard](https://gitbank.io/app/dashboard)
- Onboarding: [gitbank.io/app/onboarding](https://gitbank.io/app/onboarding)
- Contracts: [github.com/gitbankio/contracts](https://github.com/gitbankio/contracts)

---

## License

Apache 2.0. See [LICENSE](LICENSE).
`;

const COMMANDS = `# Gitbank Bot Command Reference

All commands are sent as GitHub comments mentioning \`@gitbankbot\`.
Commands work in any language. Receipts are always in English.

---

## Personal Vault

### Check balance

\`\`\`
@gitbankbot balance
\`\`\`

Shows your locked balances for all supported tokens (gitUSDC, gitWETH, etc.).

---

### Deposit (gitShield)

\`\`\`
@gitbankbot deposit 50 USDC
@gitbankbot deposit 0.01 WETH
\`\`\`

Locks tokens into your vault. The bot replies with your owner address.
Send the tokens there and the bot locks them automatically within 30 seconds.
Supports any ERC-20. A 0.10% protocol fee applies (minimum $0.05).

To cancel a pending deposit before it is detected:

\`\`\`
@gitbankbot cancel
\`\`\`

---

### Withdraw (gitUnshield)

\`\`\`
@gitbankbot withdraw 50 USDC to 0xYourWalletAddress
@gitbankbot withdraw 0.01 WETH to 0xYourWalletAddress
\`\`\`

Burns gitTokens and sends the underlying tokens to your specified wallet.
A 0.10% protocol fee applies (minimum $0.05).
The destination must be a 0x wallet address on Base.

---

### Swap (gitSwap)

\`\`\`
@gitbankbot swap 0.01 WETH to USDC
@gitbankbot swap 30 USDC to WETH
\`\`\`

Swaps locked tokens inside your vault via DEX routing. Burns input gitTokens,
routes through Aerodrome or Uniswap, mints output gitTokens.
A 0.30% protocol fee applies (minimum $0.10).
Swap output is limited to WETH or USDC (enforced on-chain).

---

### Transfer to contributor

\`\`\`
@gitbankbot send 20 USDC to @alice
\`\`\`

Transfers locked tokens from your vault to another Gitbank user's vault.
Uses a 2-step commit-reveal pattern to prevent front-running.
No fee.

---

### Transaction history

\`\`\`
@gitbankbot history
\`\`\`

Links to your full transaction history on the dashboard.

---

### Help

\`\`\`
@gitbankbot help
\`\`\`

Shows a quick reference in the thread.

---

## Project Workspace

### Create a project

\`\`\`
@gitbankbot create project 'Sprint 1' with 500 USDC budget
\`\`\`

Creates a project with a locked USDC budget in your vault.

---

### Assign a bounty

\`\`\`
@gitbankbot assign this task to @alice with 80 USDC bounty
\`\`\`

Allocates a portion of project budget as a bounty for a contributor.
The bounty is locked on-chain until the PR is merged or the task is cancelled.

---

### Auto-payout on PR merge

When a PR linked to a bounty is merged, the bot automatically pays the contributor.
No command needed. It triggers automatically on the \`pull_request\` merged event.

---

### Cancel a task and reclaim bounty

\`\`\`
@gitbankbot cancel this task and reclaim bounty
\`\`\`

Cancels the task, unallocates the bounty, and returns funds to the project budget.

---

### Project status

\`\`\`
@gitbankbot project status Sprint 1
\`\`\`

Shows budget used, tasks assigned, completed, and cancelled for the project.

---

## Multilingual examples

The bot understands commands in any language:

| Language | Example |
|---|---|
| Indonesian | \`@gitbankbot deposit 50 USDC\` |
| Japanese | \`@gitbankbot 0.01 WETHをデポジットする\` |
| Chinese | \`@gitbankbot 存入 50 USDC\` |
| German | \`@gitbankbot 50 USDC einzahlen\` |
| Spanish | \`@gitbankbot depositar 50 USDC\` |
| Russian | \`@gitbankbot внести 50 USDC\` |

---

## Error codes

| Message | Meaning |
|---|---|
| "Vault deploying!" | First-time setup. Wait 30 seconds then repeat your command. |
| "Your vault is still confirming on-chain" | Vault tx not yet confirmed. Wait 30 seconds and try again. |
| "No active pending commands to cancel" | No deposit watcher is running for your account. |
| "Rate limit reached" | 10 commands per hour per account. Try again later. |
| "I could not understand that command" | Rephrase or use \`@gitbankbot help\` for examples. |
`;

const APACHE_LICENSE = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Copyright 2026 Gitbank

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
`;

// ── Discussion content ─────────────────────────────────────────────────────────

const WELCOME_TITLE = "Welcome to Gitbank Playground - Start here";

const WELCOME_BODY = `Welcome to the Gitbank Playground! This is the place to test all Gitbank bot commands on Base Sepolia testnet.

## How to start

No setup required. Just mention \`@gitbankbot\` in any Issue or Discussion here and the bot will deploy your vault automatically on your first command.

**Step 1: Get testnet tokens**

- USDC: [faucet.circle.com](https://faucet.circle.com) (select Base Sepolia)
- ETH: [alchemy.com/faucets/base-sepolia](https://www.alchemy.com/faucets/base-sepolia) (then wrap to WETH at app.uniswap.org)

**Step 2: Try a command**

\`\`\`
@gitbankbot help
@gitbankbot balance
@gitbankbot deposit 10 USDC
\`\`\`

The bot replies in seconds with a receipt and a Basescan link. All tokens here are testnet only - safe to experiment freely.

**Step 3: Monitor your vault (optional)**

Visit [gitbank.io/app/dashboard](https://gitbank.io/app/dashboard) to see balances, transaction history, and connected repos.

## Full command list

See [COMMANDS.md](COMMANDS.md) for everything the bot supports including project workspace commands (create project, assign bounty, auto-payout on PR merge).

---

Questions? Open a new Discussion in the Q&A category. The team monitors this repo.`;

// ── Main ───────────────────────────────────────────────────────────────────────

console.log("Authenticating with GitHub App...");
const jwt   = makeJwt(APP_ID, PEM);
const token = await getInstallationToken(jwt, ORG);
console.log("  Token obtained.");

// 1. Push files
console.log(`\nPushing files to ${ORG}/${REPO}...`);
const tmp = join(tmpdir(), `gitbank-${REPO}-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

try {
  run("git init -b main", tmp);
  run(`git config user.name "${GIT_AUTHOR_NAME}"`, tmp);
  run(`git config user.email "${GIT_AUTHOR_EMAIL}"`, tmp);

  writeFileSync(join(tmp, "README.md"),  README);
  writeFileSync(join(tmp, "COMMANDS.md"), COMMANDS);
  writeFileSync(join(tmp, "LICENSE"),    APACHE_LICENSE);

  commitAll("init: README, command reference, Apache 2.0 license", tmp);

  const remote = `https://x-access-token:${token}@github.com/${ORG}/${REPO}.git`;
  run(`git remote add origin ${remote}`, tmp);
  run("git push -u origin main --force", tmp);

  console.log(`\n  Files pushed: https://github.com/${ORG}/${REPO}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 2. Get repo node ID + discussion category IDs
console.log("\nFetching repo info for Discussion setup...");
const repoData = await gql(token, `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      discussionCategories(first: 20) {
        nodes { id name }
      }
    }
  }
`, { owner: ORG, name: REPO });

const repoId     = repoData.repository.id;
const categories = repoData.repository.discussionCategories.nodes;
console.log("  Available categories:", categories.map((c) => c.name).join(", "));

// Prefer "General", fallback to "Announcements", fallback to first available
const category =
  categories.find((c) => c.name === "General") ??
  categories.find((c) => c.name === "Announcements") ??
  categories[0];

if (!category) {
  console.error("  No discussion categories found. Enable Discussions in repo settings first.");
  process.exit(1);
}
console.log(`  Using category: ${category.name}`);

// 3. Create welcome discussion
console.log("\nCreating welcome Discussion...");
const discussionData = await gql(token, `
  mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
    createDiscussion(input: {
      repositoryId: $repoId,
      categoryId: $categoryId,
      title: $title,
      body: $body
    }) {
      discussion { url number }
    }
  }
`, {
  repoId,
  categoryId: category.id,
  title: WELCOME_TITLE,
  body:  WELCOME_BODY,
});

const disc = discussionData.createDiscussion.discussion;
console.log(`\n  Discussion created: ${disc.url}`);

console.log(`
Done.
  Repo:       https://github.com/${ORG}/${REPO}
  Discussion: ${disc.url}
`);
