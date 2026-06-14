---
title: "Gitbank Plugin (Relayer Mode)"
description: "Plugin reference for managing GitHub-linked soul-bound vaults on Base Mainnet. Read operations are plain GET requests. Write operations queue a pending request, require GitHub identity confirmation, then Gitbank executes the transaction on-chain. No wallet required. Zero gas cost for users."
---

# Gitbank Plugin

Gitbank is an IssueOps platform for Web3 dev teams. Every GitHub account gets a soul-bound vault on Base Mainnet, anchored to the account's permanent GitHub user ID. Vaults hold USDC and WETH.

**This plugin uses relayer mode.** No wallet or crypto setup required from the user. Write operations queue a pending command and return a confirm code. The user authorizes by posting one comment on GitHub. The bot verifies identity: **only the exact GitHub account whose username was used in the prepare request can confirm it.** After confirmation, Gitbank's relayer executes the transaction and pays all gas. Zero ETH cost for users.

**Chain:** Base Mainnet (`8453`)

**Supported tokens:** USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), WETH (`0x4200000000000000000000000000000000000006`)

**Gitbank API base URL:** `https://gitbank.io/api/public`

---

## How it works (relayer mode)

```
User: "Swap 50 USDC to WETH, GitHub username: alice"

1. AI calls GET /vault/by-github/alice
   -> vault deployed, USDC balance: 250.00

2. AI calls GET /prepare/swap?username=alice&amount=50&from_token=USDC&to_token=WETH
   -> { confirm_code: "mcp1a2b3c4d", instructions: "..." }

3. AI shows the user:
   "To authorize, open: https://github.com/gitbankio/playground/discussions/4#new_comment_form
    And post: @gitbankbot confirm mcp1a2b3c4d
    (Expires in 10 minutes. Only @alice can confirm it.)"

4. User opens the link and posts the comment on GitHub as @alice.

5. Gitbank bot detects the comment.
   SECURITY CHECK: If the commenter is NOT @alice, the bot rejects it.

6. If identity confirmed: Gitbank relayer builds and submits the transaction.
   Gitbank pays all gas. User pays zero ETH.

7. AI polls GET /pending/mcp1a2b3c4d every 3-5 seconds until status = "executed".
   -> { status: "executed", tx_hash: "0xabc...", basescan: "https://basescan.org/tx/0xabc..." }

8. AI shows: "Swap complete. View on Basescan: https://basescan.org/tx/0xabc..."
```

**Identity guarantee:** GitHub webhook payloads are HMAC-signed by GitHub. The bot reads sender identity from the signed payload only. It cannot be spoofed by calling the API directly.

---

## Read Endpoints

### `GET /api/public/vault/by-github/:github_username`

Returns the vault address and current USDC + WETH balances. **Always call this first** to confirm the vault is deployed and check available balance.

```
GET https://gitbank.io/api/public/vault/by-github/alice
```

Response (vault deployed):

```json
{
  "github_username": "alice",
  "vault_address": "0x...",
  "vault_deployed": true,
  "USDC": "250.00",
  "WETH": "0.050000",
  "chain": "base",
  "chain_id": 8453
}
```

Response (vault not yet deployed):

```json
{
  "github_username": "alice",
  "vault_deployed": false
}
```

If `vault_deployed` is `false`, proceed normally. The vault auto-deploys on the first prepare request (free, relayer pays gas).

### `GET /api/public/vault/:vault_address`

Returns balances for a known vault address directly.

---

## Prepare Endpoints

Prepare endpoints queue a pending vault operation and return a confirm code. The operation is not executed until the user confirms on GitHub as the correct account. Codes expire after 10 minutes.

> [!NOTE]
> If `gitbank.io` is not on your client's fetch allowlist, construct the full URL, show it to the user, ask them to paste the JSON response back into chat, then read the `instructions` field and show it to the user.

### `GET /api/public/prepare/deposit`

Queues a deposit of USDC or WETH into the vault.

```
GET https://gitbank.io/api/public/prepare/deposit?username=alice&amount=50&token=USDC
```

| Param | Required | Description |
|-------|----------|-------------|
| `username` | yes | GitHub username |
| `amount` | yes | Human-decimal amount (e.g. `50` for 50 USDC, `0.001` for 0.001 WETH) |
| `token` | yes | `USDC` or `WETH` |

### `GET /api/public/prepare/withdraw`

Queues a withdrawal from the vault to a wallet address.

```
GET https://gitbank.io/api/public/prepare/withdraw?username=alice&amount=50&token=USDC&to=0x...
```

| Param | Required | Description |
|-------|----------|-------------|
| `username` | yes | GitHub username |
| `amount` | yes | Human-decimal amount |
| `token` | yes | `USDC` or `WETH` |
| `to` | yes | Destination wallet address |

A 0.1% protocol fee applies.

### `GET /api/public/prepare/swap`

Queues a Uniswap v3 swap inside the vault.

```
GET https://gitbank.io/api/public/prepare/swap?username=alice&amount=50&from_token=USDC&to_token=WETH
```

| Param | Required | Description |
|-------|----------|-------------|
| `username` | yes | GitHub username |
| `amount` | yes | Human-decimal amount of `from_token` |
| `from_token` | yes | `USDC` or `WETH` |
| `to_token` | yes | `USDC` or `WETH` (must differ from `from_token`) |

A 0.3% protocol fee applies.

**All prepare endpoints return the same shape:**

```json
{
  "ok": true,
  "command": "swap",
  "username": "alice",
  "vault_address": "0x...",
  "amount": 50,
  "from_token": "USDC",
  "to_token": "WETH",
  "confirm_code": "mcp1a2b3c4d",
  "instructions": "Swap 50 USDC to WETH in @alice's vault queued.\n\nTo authorize, open:\nhttps://github.com/gitbankio/playground/discussions/4#new_comment_form\n\nAnd post this comment:\n@gitbankbot confirm mcp1a2b3c4d\n\n(Expires in 10 minutes. Only @alice can confirm it.)",
  "confirm_url": "https://github.com/gitbankio/playground/discussions/4#new_comment_form",
  "expires_in_seconds": 600
}
```

**Always show the `instructions` field verbatim to the user.** It contains the exact comment they need to post.

---

## Poll Endpoint

After the user confirms on GitHub, the Gitbank relayer executes the transaction automatically. Poll this endpoint to get the result.

### `GET /api/public/pending/:confirm_code`

```
GET https://gitbank.io/api/public/pending/mcp1a2b3c4d
```

Returns:

```json
{
  "ok": true,
  "confirm_code": "mcp1a2b3c4d",
  "command": "swap",
  "username": "alice",
  "status": "executed",
  "result": "amount_in: 50.00 USDC\namount_out: 0.022419 WETH\ntx_hash: 0xabc123...\nbasescan: https://basescan.org/tx/0xabc123...",
  "tx_hash": "0xabc123...",
  "basescan": "https://basescan.org/tx/0xabc123..."
}
```

**Status values:**

| Status | Meaning |
|--------|---------|
| `pending` | Queued, waiting for GitHub confirmation |
| `confirmed` | GitHub identity verified, relayer is executing |
| `executed` | Transaction confirmed on Base Mainnet |
| `failed` | Execution failed (see `result` for details) |
| `expired` | Confirm code expired (10-minute TTL) |

Poll every 3-5 seconds. Stop when status is `executed`, `failed`, or `expired`.

---

## Orchestration Pattern

```
1. GET /vault/by-github/:username
   -> note vault_deployed and balances (vault auto-deploys if needed)

2. GET /prepare/<deposit|withdraw|swap>?username=<username>&...
   -> confirm_code, instructions, confirm_url

3. Show the user the instructions field verbatim.
   Tell them to open confirm_url and post the shown comment.
   Remind them: only their GitHub account can confirm this.

4. Wait for the user to say they confirmed on GitHub.

5. Poll GET /pending/:confirm_code every 3-5 seconds.
   Show: "Waiting for Gitbank to execute your transaction..."

6. When status = "executed":
   Show result and basescan link.
```

---

## Example Sessions

**Check vault balance**

```
What's in my Gitbank vault? My GitHub username is alice.
```

1. `GET /vault/by-github/alice` -> show USDC and WETH balances.

---

**Swap 50 USDC to WETH**

```
Swap 50 USDC to WETH in my Gitbank vault. GitHub: alice.
```

1. `GET /vault/by-github/alice` -> confirm USDC balance >= 50.
2. `GET /prepare/swap?username=alice&amount=50&from_token=USDC&to_token=WETH` -> confirm_code.
3. Show user the instructions verbatim.
4. User posts comment on GitHub as @alice. Relayer executes.
5. Poll `GET /pending/mcp1a2b3c4d` until `status = "executed"`.
6. Show tx_hash and basescan link.

---

**Withdraw 50 USDC to wallet**

```
Withdraw 50 USDC from alice's Gitbank vault to 0x1234...
```

1. `GET /vault/by-github/alice` -> confirm USDC balance >= 50.
2. `GET /prepare/withdraw?username=alice&amount=50&token=USDC&to=0x1234...` -> confirm_code.
3. Show instructions. User confirms on GitHub. Relayer executes.
4. Poll until executed. Show result.

---

**Deposit 100 USDC**

```
Deposit 100 USDC into my Gitbank vault. GitHub: alice.
```

1. `GET /vault/by-github/alice` -> vault_address.
2. `GET /prepare/deposit?username=alice&amount=100&token=USDC` -> confirm_code.
3. Show instructions. User confirms. Relayer executes. Poll. Show result.

---

## Operation Summary

| Operation | Prepare endpoint | Auth method | Who pays gas |
|-----------|-----------------|-------------|-------------|
| Deposit USDC/WETH | `/prepare/deposit` | GitHub confirm (identity verified) | Gitbank relayer (free for user) |
| Withdraw USDC/WETH | `/prepare/withdraw` | GitHub confirm (identity verified) | Gitbank relayer (free for user) |
| Swap USDC to WETH | `/prepare/swap` | GitHub confirm (identity verified) | Gitbank relayer (free for user) |

---

## Security Model

- **GitHub identity is mandatory.** The confirm code is bound to a specific GitHub username. Only that account can post the confirm comment. If a different account tries, the bot rejects with: "This command was requested by @alice. Only they can confirm it."
- **No execution before identity check.** The prepare endpoint returns only a confirm code. Nothing is signed or executed until the Gitbank bot verifies the commenter via HMAC-signed GitHub webhook.
- **Relayer executes atomically.** Transaction is built, signed, and submitted by the Gitbank relayer after identity verification.
- **Destination address is locked.** For withdrawals, the destination is embedded in the ownerSig verified by the vault contract. Calldata cannot redirect funds.

---

## Error Handling

| HTTP | `error` field | Meaning |
|------|--------------|---------|
| 400 | `"username, amount, and token are required"` | Missing query param |
| 400 | `"Invalid destination address"` | `to` is not a valid EVM address |
| 400 | `"Unsupported token. Use USDC or WETH"` | Unknown token symbol |
| 400 | `"from_token and to_token must differ"` | Swap source equals destination |
| 404 | `"User not found"` | GitHub username not in Gitbank |
| 404 | `"Confirm code not found"` | Code not in DB or expired |

---

## Notes

- GitHub username lookup is case-insensitive.
- Vaults auto-deploy on the first prepare request. No prior setup at gitbank.io required.
- Only the GitHub user whose username was used in the prepare request can confirm it.
- Confirm codes expire in 10 minutes. If expired, repeat the prepare request.
- GitVaultFactory on Base Mainnet: `0xAA0a4ff46733EBaE8E658642A1314f18980fc77B`
- For Base/Coinbase Wallet mode (user submits tx themselves via EIP-5792), download the Base plugin at `https://gitbank.io/api/public/plugin/download`.
- For MCP server mode (native MCP tools in Claude Desktop, Cursor, Grok), connect to `https://gitbank.io/api/mcp`.
