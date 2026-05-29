# Contributing to gitbank/server

Thanks for your interest in contributing.

## Before you start

- Open an issue first for non-trivial changes
- For bugs, include steps to reproduce and expected vs actual behavior

## Development setup

```bash
pnpm install
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server run dev
```

## Conventions

### API changes

The API contract lives in `api-spec/openapi.yaml`. This is the source of truth.

1. Edit the OpenAPI spec first
2. Run codegen: `pnpm --filter @workspace/api-spec run codegen`
3. Implement the route in `api-server/src/routes/`
4. Use generated Zod schemas for input/output validation

Never edit files in `api-zod/src/generated/` directly.

### Database changes

The schema lives in `db/src/schema/index.ts`.

1. Edit the schema
2. Run: `pnpm --filter @workspace/db run push` (dev only)
3. For production, generate and apply a migration

### Logging

Never use `console.log` in server code. Use `req.log` in route handlers and the singleton `logger` for non-request contexts.

## Type checking

```bash
pnpm run typecheck
```

Must pass with zero errors before opening a PR.

## Pull requests

- One concern per PR
- Clear description of what changed and why
- Reference related issues with `Closes #<number>`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
