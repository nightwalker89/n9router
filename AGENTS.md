# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

9Router is a self-hosted AI routing gateway built on Next.js 16 + React 19. It acts as a local proxy between AI coding tools (Codex, Cursor, Codex, Gemini CLI, etc.) and 40+ upstream AI providers. It provides format translation (OpenAI <-> Codex <-> Gemini <-> etc.), multi-account fallback, quota tracking, and usage monitoring. The app exposes an OpenAI-compatible endpoint at `/v1/*` and a web dashboard at `/dashboard`.

## Common Commands

```bash
# Development
cp .env.example .env          # first time only
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev

# Production build
npm run build
PORT=20128 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run start

# Bun alternative
npm run dev:bun
npm run build:bun
npm run start:bun

# Linting
npx eslint .

# Tests (Vitest must be installed separately in /tmp)
cd /tmp && npm install vitest    # one-time setup
cd tests/ && npm test            # run all tests

# Run a single test file
cd tests/ && NODE_PATH=/tmp/node_modules /tmp/node_modules/.bin/vitest run unit/embeddingsCore.test.js --reporter=verbose

# Docker
docker build -t 9router .
docker run -d --name 9router -p 20128:20128 --env-file .env -v 9router-data:/app/data 9router
```

## Architecture

### Two-Layer Routing Core

The system has a split routing architecture:

- **`src/sse/`** — App-level SSE handlers. Entry point is `src/sse/handlers/chat.js`. Handles model/combo resolution, credential selection, and delegates to the core.
- **`open-sse/`** — Shared, provider-agnostic routing engine (publishable as a separate package). Contains the core chat orchestration (`handlers/chatCore.js`), provider executors, format translators, and stream utilities.

Request flow: `API route → src/sse/handlers/chat.js → open-sse/handlers/chatCore.js → executor → upstream provider → response translator → client`

### Path Aliases

Defined in `jsconfig.json`:
- `@/*` → `./src/*`
- `open-sse` / `open-sse/*` → `./open-sse/*`

### API Routes (`src/app/api/`)

Two categories of API routes:

1. **Compatibility APIs** (consumed by CLI tools):
   - `/v1/chat/completions` — OpenAI-format chat (main entry point)
   - `/v1/messages` — Anthropic Codex format
   - `/v1/responses` — OpenAI Responses API format
   - `/v1/embeddings`, `/v1/models`, `/v1beta/models`
   - URL rewrites in `next.config.mjs` map `/v1/*` → `/api/v1/*`

2. **Management APIs** (consumed by the dashboard):
   - `/api/providers*`, `/api/provider-nodes*` — provider CRUD
   - `/api/oauth/*` — OAuth flows for provider connections
   - `/api/keys*`, `/api/combos*`, `/api/models/alias` — API keys, model combos, aliases
   - `/api/settings/*`, `/api/auth/*`, `/api/usage/*`, `/api/sync/*`

### Format Translation System (`open-sse/translator/`)

Translates between provider-specific formats. Source format is auto-detected from the request endpoint and body shape (see `formats.js`). Supported formats: `openai`, `openai-responses`, `Codex`, `gemini`, `vertex`, `codex`, `antigravity`, `kiro`, `cursor`, `ollama`.

- `translator/request/` — Inbound translation (e.g., `openai-to-Codex.js`)
- `translator/response/` — Outbound translation (e.g., `Codex-to-openai.js`)

### Provider Executors (`open-sse/executors/`)

Each executor handles a specific provider's auth, API endpoint construction, and credential refresh. Examples: `codex.js`, `cursor.js`, `gemini-cli.js`, `kiro.js`, `iflow.js`, `antigravity.js`, `vertex.js`. The `default.js` executor handles standard OpenAI-compatible providers.

### Combo + Account Fallback

- **Combos**: Named sequences of models tried in order (e.g., subscription → cheap → free)
- **Account fallback**: Multiple accounts per provider, round-robin with cooldown on failure
- Logic in `open-sse/services/accountFallback.js` and `src/sse/handlers/chat.js` (combo orchestration)

### Persistence

- **State DB**: `src/lib/localDb.js` → `${DATA_DIR}/db.json` (or `~/.n9router/db.json`). Uses lowdb. Stores provider connections, nodes, aliases, combos, API keys, settings, pricing.
- **Usage DB**: `src/lib/usageDb.js` → `~/.n9router/usage.json` + `~/.n9router/log.txt`. Independent from `DATA_DIR`.

### Frontend

- Next.js App Router with dashboard pages under `src/app/(dashboard)/dashboard/`
- Zustand stores in `src/store/` (providerStore, userStore, themeStore, notificationStore)
- UI components in `src/shared/components/`
- Tailwind CSS v4 via PostCSS plugin

### MITM Proxy (`src/mitm/`)

Separate child process for intercepting HTTPS traffic from CLI tools. Has its own cert generation (`cert/`), DNS handling, and Express server.

### Cloud Worker (`cloud/`)

Cloudflare Workers deployment for optional cloud sync relay. Has its own `wrangler.toml`, `package.json`, and separate source in `cloud/src/`.

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Required. Signs dashboard auth tokens |
| `INITIAL_PASSWORD` | Required. Dashboard login password |
| `DATA_DIR` | Persistent storage directory (default: `~/.n9router`) |
| `PORT` | Server port (default: 20128) |
| `NEXT_PUBLIC_BASE_URL` | Public URL for the instance |
| `REQUIRE_API_KEY` | Enforce API key on `/v1/*` routes |
| `ENABLE_REQUEST_LOGS` | Log full request/response bodies |

## Testing Notes

- Tests live in `tests/unit/` and use Vitest v4
- Vitest is installed in `/tmp/node_modules` to avoid conflicts with the root Next.js project's hoisting
- Test config is at `tests/vitest.config.js` — it aliases `open-sse` to the local package
- Current coverage: embeddings core, cloud worker handler, OAuth cursor auto-import, OpenAI-to-Codex translation, provider validation, translator request normalization

## CI/CD

- GitHub Actions workflow at `.github/workflows/docker-publish.yml`
- Triggers on version tags (`v*`) and manual dispatch
- Builds and pushes Docker image to `ghcr.io`
- Docker uses multi-stage build with `node:20-alpine`, standalone Next.js output
