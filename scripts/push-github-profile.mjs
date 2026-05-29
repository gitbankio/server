#!/usr/bin/env node
/**
 * push-github-profile.mjs
 * Pushes gitbankio/.github org profile README + banner.
 */

import { execSync }                        from "child_process";
import { writeFileSync, readFileSync,
         mkdirSync, rmSync, existsSync }   from "fs";
import { createSign }                      from "crypto";
import { tmpdir }                          from "os";
import { join }                            from "path";

// ── PEM normalizer ────────────────────────────────────────────────────────────
function normalizePem(raw) {
  if (!raw) return "";
  let pem = raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (pem.includes("\n")) return pem;
  const match = pem.match(/-----BEGIN ([^-]+)-----\s*([\s\S]+?)\s*-----END \1-----/);
  if (!match) throw new Error("Invalid PEM");
  const type = match[1];
  const b64  = match[2].replace(/\s+/g, "");
  const body = (b64.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----\n`;
}

const APP_ID = process.env.GITHUB_APP_ID;
const PEM    = normalizePem(process.env.GITHUB_APP_PEM ?? "");
const ORG    = process.env.GITHUB_ORG ?? "gitbankio";

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

// ── GitHub App auth ───────────────────────────────────────────────────────────
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
    throw new Error(`No installation for "${org}". Found: [${accounts || "none"}]`);
  }
  const tokRes = await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
  });
  if (!tokRes.ok) throw new Error(`get token failed: ${await tokRes.text()}`);
  const { token } = await tokRes.json();
  return token;
}

function run(cmd, cwd) {
  const safe = cmd.replace(/x-access-token:[^@]+@/, "x-access-token:***@");
  console.log(`  $ ${safe}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// ── README content ────────────────────────────────────────────────────────────
const README = `![Gitbank](./banner.png)

![Base L2](https://img.shields.io/badge/Base_L2-0052FF?style=flat-square&logo=coinbase&logoColor=white)
![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636?style=flat-square&logo=solidity&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![Claude Haiku](https://img.shields.io/badge/Claude_Haiku-NLP_Parser-D4A017?style=flat-square)
![GitHub App](https://img.shields.io/badge/GitHub_App-Bot-181717?style=flat-square&logo=github&logoColor=white)
![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)

# Gitbank

The secure on-chain bank inside your GitHub.

Gitbank gives every developer and AI agent a personal vault on Base L2, anchored to their GitHub identity. Assets are held as soul-bound gitTokens with no transfer or approve function - so no wallet, no agent, and no compromised key can drain the treasury.

## Command flow

\`\`\`mermaid
flowchart LR
    A(["developer\\nor AI agent"]) -->|"@gitbankbot assign\\n@alice 80 USDC"| B["GitHub Issue / PR"]

    subgraph Gitbank
        C["webhook\\nhandler"]
        D["Claude Haiku\\nNLP parser"]
        E["viem relayer\\nsign + submit"]
    end

    B -->|HMAC webhook| C
    C --> D
    D -->|structured intent| C
    C --> E

    subgraph "Base L2"
        F["GitVault\\nContract"]
        G["gitUSDC\\nescrowed for @alice"]
    end

    E --> F
    F --> G

    H(["PR merged"]) -->|auto-payout trigger| C
    G -->|burn escrow\\n+ release| I(["@alice\\nreceives USDC"])
    C -->|receipt + tx hash| B
\`\`\`

## What we build

| Repo | Description |
|------|-------------|
| [gitbankio/contracts](https://github.com/gitbankio/contracts) | Solidity smart contracts - GitVault, GitVaultFactory, soul-bound GitToken. Deployed on Base L2. |
| [gitbankio/server](https://github.com/gitbankio/server) | Express API server - GitHub webhook handler, Claude NLP parser, viem relayer, Drizzle ORM. |
| [gitbankio/app](https://github.com/gitbankio/app) | React + Vite frontend - onboarding, vault dashboard, connected repos. |

## How it works

1. Install [@gitbankbot](https://github.com/apps/gitbankbot) on your repo
2. Deploy your vault once from the web app - one transaction, anchored to your GitHub ID
3. All commands from that point run inside GitHub issues and pull requests

Gas is covered by Gitbank. Receipt is posted back to the thread within seconds.

## Security model

- **Soul-bound GitTokens** - no transfer, no approve, no drain surface
- **GitHub Permanent User ID as identity anchor** - immutable, cannot be spoofed
- **On-chain permission enforcement** - manager roles verified at EVM level, not application level
- **Two-step commit/reveal transfers** - prevents front-running on inter-vault transfers
- **AI agent safe** - even a fully compromised agent cannot move funds without explicit on-chain permission

## Stack

Base L2 - Solidity 0.8.24 - OpenZeppelin 5 - viem - Express 5 - Drizzle ORM - React 19 - Vite 7 - Claude Haiku

## License

Apache 2.0 - see [LICENSE](https://github.com/gitbankio/contracts/blob/main/LICENSE)
`;

// ── Main ──────────────────────────────────────────────────────────────────────
const jwt   = makeJwt(APP_ID, PEM);
const token = await getInstallationToken(jwt, ORG);
console.log(`Got installation token for ${ORG}`);

const tmp = join(tmpdir(), "gitbank-github-profile");
if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// Clone or init
const repoUrl = `https://x-access-token:${token}@github.com/${ORG}/.github.git`;
console.log(`  Cloning ${ORG}/.github ...`);
try {
  execSync(`git clone --depth=1 "${repoUrl}" "${tmp}"`, { stdio: "pipe" });
  console.log("  Cloned existing repo.");
} catch {
  // Repo doesn't exist or is empty — already cloned as empty, just set remote
  console.log("  Empty or new repo, setting remote...");
  execSync(`git remote set-url origin "${repoUrl}"`, { cwd: tmp, stdio: "pipe" });
}

// Write files into profile/
const profileDir = join(tmp, "profile");
mkdirSync(profileDir, { recursive: true });

writeFileSync(join(profileDir, "README.md"), README);
// Copy banner
const bannerSrc = new URL("../attached_assets/gitbank-org-banner.png", import.meta.url).pathname;
const bannerBytes = readFileSync(bannerSrc);
writeFileSync(join(profileDir, "banner.png"), bannerBytes);

// Git commit + push
run(`${GIT_ENV} git config user.email "${GIT_AUTHOR_EMAIL}"`, tmp);
run(`${GIT_ENV} git config user.name "${GIT_AUTHOR_NAME}"`, tmp);
run(`git add -A`, tmp);
run(`${GIT_ENV} git commit -m "feat: org profile README with banner and badges"`, tmp);
run(`git push --force origin HEAD:main`, tmp);

console.log(`\nDone! https://github.com/${ORG}/.github`);
