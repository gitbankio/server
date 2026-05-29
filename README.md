# gitbank/server

GitHub bot and API server for Gitbank. Handles webhook events, parses natural-language commands, and submits transactions to the vault contracts on Base L2.

## Structure

```
api-server/     Express 5 API server + GitHub bot webhook handler
db/             PostgreSQL schema (Drizzle ORM)
api-spec/       OpenAPI 3.1 spec (source of truth for API contract)
api-zod/        Generated Zod schemas from OpenAPI spec
scripts/        Utility scripts
```

## How the bot works

1. User mentions `@gitbankbot` in a GitHub Issue or PR comment
2. GitHub sends a webhook to `POST /api/webhook`
3. Server verifies HMAC signature
4. Claude Haiku parses the natural-language command into structured intent
5. Relayer builds and submits the transaction using the user's encrypted execution keypair
6. Bot replies to the thread with a plain-English receipt

## Prerequisites

- Node.js 20+
- pnpm 10+
- PostgreSQL 15+

## Install

```bash
pnpm install
```

## Environment variables

```env
DATABASE_URL=                  # postgresql://...
SESSION_SECRET=                # random 64-char hex
ENCRYPTION_MASTER_KEY=         # random 64-char hex (AES-256-GCM master key)

GITHUB_APP_ID=
GITHUB_APP_PEM=                # full PEM with newlines
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_WEBHOOK_SECRET=

BASE_SEPOLIA_RPC_URL=
BASE_MAINNET_RPC_URL=
BASE_NETWORK=                  # "mainnet" or leave empty for sepolia

GIT_VAULT_FACTORY_ADDRESS=
RELAYER_SIGNING_KEY=           # 0x-prefixed private key for relayer ECDSA signing
ANTHROPIC_API_KEY=

ALLOWED_DOMAINS=               # comma-separated allowed CORS origins
```

## Run (development)

```bash
# Push DB schema
pnpm --filter @workspace/db run push

# Start API server (port 8080 by default)
pnpm --filter @workspace/api-server run dev
```

## API codegen

After changing `api-spec/openapi.yaml`, regenerate Zod schemas and React Query hooks:

```bash
pnpm --filter @workspace/api-spec run codegen
```

## GitHub App setup

1. Create a GitHub App with webhook URL pointing to `https://yourdomain.com/api/webhook`
2. Enable `Issues` and `Pull requests` read/write permissions
3. Subscribe to `issue_comment` and `pull_request_review_comment` events
4. Generate and download a private key (PEM)
5. Set `GITHUB_APP_ID`, `GITHUB_APP_PEM`, and `GITHUB_WEBHOOK_SECRET`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
