#!/usr/bin/env node
/**
 * push-x402-fork.mjs
 * Pushes examples/typescript/clients/issueops-payer/ to teamgitbank/x402 fork.
 *
 * Required env vars:
 *   GITHUB_APP_ID   - numeric App ID
 *   GITHUB_APP_PEM  - full PEM private key (with newlines)
 */

import { execSync }                          from "child_process";
import { writeFileSync, mkdirSync, rmSync,
         existsSync }                        from "fs";
import { createSign }                        from "crypto";
import { tmpdir }                            from "os";
import { join }                              from "path";

// ── PEM normalizer ────────────────────────────────────────────────────────────

function normalizePem(raw) {
  if (!raw) return "";
  let pem = raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (pem.includes("\n")) return pem;
  const match = pem.match(/-----BEGIN ([^-]+)-----\s*([\s\S]+?)\s*-----END \1-----/);
  if (!match) throw new Error("Invalid PEM: could not find BEGIN/END markers");
  const type  = match[1];
  const b64   = match[2].replace(/\s+/g, "");
  const body  = (b64.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----\n`;
}

// ── Config ────────────────────────────────────────────────────────────────────

const APP_ID = process.env.GITHUB_APP_ID;
const PEM    = normalizePem(process.env.GITHUB_APP_PEM ?? "");

const FORK_OWNER = "teamgitbank";
const FORK_REPO  = "x402";

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

async function getInstallationToken(jwt, account) {
  const listRes = await fetch("https://api.github.com/app/installations?per_page=100", {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
  });
  if (!listRes.ok) throw new Error(`list installations failed: ${await listRes.text()}`);
  const installations = await listRes.json();

  console.log("App installed on:", installations.map(i => i.account?.login).join(", "));

  const inst = installations.find(
    (i) => i.account?.login?.toLowerCase() === account.toLowerCase()
  );
  if (!inst) {
    // Try creating a token scoped to the specific repo via user installation
    throw new Error(
      `No installation found for "${account}". ` +
      `Install the GitHub App on the ${account} account first, ` +
      `or fork the repo and grant App access to it.`
    );
  }

  const tokRes = await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ repositories: [FORK_REPO] }),
  });
  if (!tokRes.ok) throw new Error(`get token failed: ${await tokRes.text()}`);
  const { token } = await tokRes.json();
  return token;
}

// ── Shell helpers ─────────────────────────────────────────────────────────────

function run(cmd, cwd) {
  const safe = cmd.replace(/x-access-token:[^@]+@/, "x-access-token:***@");
  console.log(`  $ ${safe}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// ── File contents ─────────────────────────────────────────────────────────────

const FILES = {
  "index.ts": `import { config } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { PaymentRequirements } from "@x402/core/types";
import { createServer } from "http";

config();

/**
 * IssueOps x402 Payer.
 *
 * Demonstrates a human-gated x402 payment pattern where payments are authorized
 * by a GitHub issue comment, not triggered automatically. The payer signs payments
 * server-side only after a human types the approval command in a GitHub issue.
 *
 * Flow:
 *   1. GitHub webhook delivers issue_comment event to POST /webhook
 *   2. Handler checks the comment body against the approval pattern
 *   3. On match: probes the resource server for x402 requirements (402 response)
 *   4. Signs EIP-3009 with the relayer key and retries with PAYMENT-SIGNATURE header
 *   5. Logs the settlement transaction hash from the PAYMENT-RESPONSE header
 *
 * Required environment variables:
 *   EVM_PRIVATE_KEY     - Relayer private key that signs EIP-3009
 *   RESOURCE_SERVER_URL - Base URL of the x402-protected resource server
 *
 * Optional environment variables:
 *   ENDPOINT_PATH - Path on the resource server (default: /weather)
 *   PORT          - Port for the webhook listener (default: 3000)
 */

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as \`0x\${string}\`;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const resourceUrl = \`\${baseURL}\${endpointPath}\`;
const PORT = Number(process.env.PORT ?? 3000);

/** Approval pattern: comment must start with "@gitbankbot pay". */
const APPROVAL_PATTERN = /^@gitbankbot\\s+pay\\b/i;

/**
 * Settlement result from a completed x402 payment.
 */
interface Settlement {
  transaction: string;
  network: string;
  payer: string;
  data: unknown;
}

/**
 * Executes an x402 payment for the configured resource.
 *
 * @param client - Authenticated x402 client instance
 * @returns Settlement details from the resource server
 */
async function executePayment(client: x402Client): Promise<Settlement> {
  // Probe for payment requirements
  const probe = await fetch(resourceUrl);
  if (probe.status !== 402) {
    throw new Error(\`Expected 402 from resource server, got \${probe.status}\`);
  }

  const paymentRequiredHeader = probe.headers.get("PAYMENT-REQUIRED");
  if (!paymentRequiredHeader) {
    throw new Error("Missing PAYMENT-REQUIRED header");
  }
  const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);

  const requirements: PaymentRequirements[] = Array.isArray(paymentRequired.accepts)
    ? paymentRequired.accepts
    : [paymentRequired.accepts];

  console.log("Payment requirements:");
  requirements.forEach((req, i) => {
    console.log(\`  \${i + 1}. \${req.network} / \${req.scheme} - \${req.amount}\`);
  });

  // Sign and encode payment
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeader = encodePaymentSignatureHeader(paymentPayload);

  // Send paid request
  const paid = await fetch(resourceUrl, {
    headers: { "PAYMENT-SIGNATURE": paymentHeader },
  });
  if (paid.status !== 200) {
    throw new Error(\`Payment rejected: HTTP \${paid.status}\`);
  }

  const data = await paid.json();
  const settlementHeader = paid.headers.get("PAYMENT-RESPONSE");
  if (!settlementHeader) {
    throw new Error("Missing PAYMENT-RESPONSE header");
  }
  const settlement = decodePaymentResponseHeader(settlementHeader);

  return { ...settlement, data };
}

/**
 * Checks whether a GitHub issue comment authorizes an x402 payment.
 *
 * @param body - Raw comment body from the GitHub webhook payload
 * @returns True if the comment matches the approval pattern
 */
function isApproved(body: string): boolean {
  return APPROVAL_PATTERN.test(body.trim());
}

/**
 * Handles an incoming GitHub webhook payload.
 *
 * @param payload - Parsed webhook payload from GitHub
 * @param client  - Authenticated x402 client instance
 */
async function handleWebhook(
  payload: Record<string, unknown>,
  client: x402Client,
): Promise<void> {
  if (payload.action !== "created") return;

  const comment = payload.comment as Record<string, unknown> | undefined;
  const body = typeof comment?.body === "string" ? comment.body : "";

  if (!isApproved(body)) {
    console.log(\`Skipped: "\${body.trim().slice(0, 60)}"\`);
    return;
  }

  console.log(\`Approval: "\${body.trim()}"\`);
  console.log(\`Resource: \${resourceUrl}\`);

  const result = await executePayment(client);

  console.log("Settled:");
  console.log(\`  tx:      \${result.transaction}\`);
  console.log(\`  network: \${result.network}\`);
  console.log(\`  payer:   \${result.payer}\`);
  console.log("Data:", result.data);
}

/**
 * Starts the webhook listener.
 */
async function main(): Promise<void> {
  if (!evmPrivateKey) {
    console.error("EVM_PRIVATE_KEY is required");
    process.exit(1);
  }

  const signer = privateKeyToAccount(evmPrivateKey);
  const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer));

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404).end();
      return;
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;

    try {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      await handleWebhook(payload, client);
      res.writeHead(200).end("ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Error:", message);
      res.writeHead(500).end(message);
    }
  });

  server.listen(PORT, () => {
    console.log(\`IssueOps payer listening on :\${PORT}\`);
    console.log(\`POST /webhook  -- forward GitHub issue_comment events here\`);
    console.log(\`Resource: \${resourceUrl}\`);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
`,

  "package.json": `{
  "name": "@x402/issueops-payer-example",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx index.ts",
    "dev": "tsx index.ts",
    "format": "prettier -c .prettierrc --write \\"**/*.{ts,js,cjs,json,md}\\"",
    "format:check": "prettier -c .prettierrc --check \\"**/*.{ts,js,cjs,json,md}\\"",
    "lint": "eslint . --ext .ts --fix",
    "lint:check": "eslint . --ext .ts"
  },
  "dependencies": {
    "@x402/core": "workspace:*",
    "@x402/evm": "workspace:*",
    "dotenv": "^16.4.7",
    "viem": "^2.48.11"
  },
  "devDependencies": {
    "@eslint/js": "^9.24.0",
    "@types/node": "^22.13.4",
    "@typescript-eslint/eslint-plugin": "^8.29.1",
    "@typescript-eslint/parser": "^8.29.1",
    "eslint": "^9.24.0",
    "eslint-plugin-import": "^2.31.0",
    "eslint-plugin-jsdoc": "^50.6.9",
    "eslint-plugin-prettier": "^5.2.6",
    "prettier": "3.5.2",
    "tsx": "^4.21.0",
    "typescript": "^5.7.3"
  }
}
`,

  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "strict": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "types": ["node"]
  },
  "include": ["index.ts"]
}
`,

  ".env-local": `EVM_PRIVATE_KEY=
RESOURCE_SERVER_URL=http://localhost:4021
ENDPOINT_PATH=/weather
PORT=3000
`,

  ".prettierrc": `{
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "bracketSpacing": true,
  "arrowParens": "avoid",
  "printWidth": 100,
  "proseWrap": "never"
}
`,

  ".prettierignore": `dist/
node_modules/
`,

  "eslint.config.js": `import js from "@eslint/js";
import ts from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettier from "eslint-plugin-prettier";
import jsdoc from "eslint-plugin-jsdoc";
import importPlugin from "eslint-plugin-import";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      sourceType: "module",
      ecmaVersion: 2020,
      globals: {
        process: "readonly",
        __dirname: "readonly",
        module: "readonly",
        require: "readonly",
        Buffer: "readonly",
        exports: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": ts,
      prettier: prettier,
      jsdoc: jsdoc,
      import: importPlugin,
    },
    rules: {
      ...ts.configs.recommended.rules,
      "import/first": "error",
      "prettier/prettier": "error",
      "@typescript-eslint/member-ordering": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_$" }],
      "jsdoc/tag-lines": ["error", "any", { startLines: 1 }],
      "jsdoc/check-alignment": "error",
      "jsdoc/no-undefined-types": "off",
      "jsdoc/check-param-names": "error",
      "jsdoc/check-tag-names": "error",
      "jsdoc/check-types": "error",
      "jsdoc/implements-on-classes": "error",
      "jsdoc/require-description": "error",
      "jsdoc/require-jsdoc": [
        "error",
        {
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
        },
      ],
      "jsdoc/require-param": "error",
      "jsdoc/require-param-description": "error",
      "jsdoc/require-param-type": "off",
      "jsdoc/require-returns": "error",
      "jsdoc/require-returns-description": "error",
      "jsdoc/require-returns-type": "off",
      "jsdoc/require-hyphen-before-param-description": ["error", "always"],
    },
  },
];
`,

  "README.md": `# IssueOps x402 Payer

Example of a human-gated x402 payment server. Payments are authorized by GitHub issue
comments, not triggered automatically. This suits use cases where explicit human approval
is required before funds leave a vault.

\`\`\`typescript
const APPROVAL_PATTERN = /^@gitbankbot\\s+pay\\b/i;

// Only fires when a human types "@gitbankbot pay" in a GitHub issue
if (!isApproved(comment.body)) return;
await executePayment(client);
\`\`\`

## How it works

1. A GitHub webhook forwards \`issue_comment\` events to \`POST /webhook\`
2. The handler checks the comment body against the approval pattern
3. On match: probes the resource server for x402 requirements (402 response)
4. Signs EIP-3009 with the relayer key and retries with \`PAYMENT-SIGNATURE\` header
5. Logs settlement details from the \`PAYMENT-RESPONSE\` header

This pattern is used in production by [Gitbank](https://gitbank.io), an IssueOps
platform where GitHub bot mentions authorize vault payments on Base L2. The full
implementation is at [gitbankio/x402](https://github.com/gitbankio/x402).

## Prerequisites

- Node.js v20+
- pnpm v10
- A running x402 server (see [express server example](../../servers/express))
- An EVM private key whose address holds enough tokens for the payment

## Setup

1. Install and build from the typescript examples root:

\`\`\`bash
cd ../../
pnpm install && pnpm build
cd clients/issueops-payer
\`\`\`

2. Copy \`.env-local\` to \`.env\` and fill in your values:

\`\`\`bash
cp .env-local .env
\`\`\`

## Run

\`\`\`bash
pnpm start
\`\`\`

Send a test webhook:

\`\`\`bash
curl -X POST http://localhost:3000/webhook \\
  -H "Content-Type: application/json" \\
  -d '{"action":"created","comment":{"body":"@gitbankbot pay for the weather report"}}'
\`\`\`

## Production checklist

In a production GitHub App:

- Set the webhook URL to \`https://your-server.com/webhook\`
- Subscribe to \`issue_comment\` events
- Verify \`X-Hub-Signature-256\` before processing (omitted here for clarity)
- Store \`EVM_PRIVATE_KEY\` encrypted at rest (see [AES-256-GCM key engine](https://github.com/gitbankio/x402))
`,
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const jwt = makeJwt(APP_ID, PEM);

  let token;
  try {
    token = await getInstallationToken(jwt, FORK_OWNER);
    console.log(`Got installation token for ${FORK_OWNER}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const tmpDir = join(tmpdir(), `x402-fork-${Date.now()}`);
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });

  const cloneUrl = `https://x-access-token:${token}@github.com/${FORK_OWNER}/${FORK_REPO}.git`;

  console.log(`\nCloning ${FORK_OWNER}/${FORK_REPO}...`);
  run(`git clone --depth=1 "${cloneUrl}" "${tmpDir}"`);

  // Configure git identity
  run(`git config user.name "${GIT_AUTHOR_NAME}"`, tmpDir);
  run(`git config user.email "${GIT_AUTHOR_EMAIL}"`, tmpDir);

  // Write example files
  const exampleDir = join(tmpDir, "examples", "typescript", "clients", "issueops-payer");
  mkdirSync(exampleDir, { recursive: true });

  for (const [filename, content] of Object.entries(FILES)) {
    writeFileSync(join(exampleDir, filename), content, "utf-8");
    console.log(`  wrote: ${filename}`);
  }

  // Commit
  run(`git add examples/typescript/clients/issueops-payer/`, tmpDir);
  run(
    `${GIT_ENV} git commit -m "feat(examples/typescript/clients): add issueops-payer example"`,
    tmpDir,
  );

  // Push
  console.log("\nPushing to origin...");
  run(`git push origin main`, tmpDir);

  // Cleanup
  rmSync(tmpDir, { recursive: true });

  console.log(`\nDone. https://github.com/${FORK_OWNER}/${FORK_REPO}/tree/main/examples/typescript/clients/issueops-payer`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
