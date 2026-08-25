# Changelog

## v0.4.54 (2026-08-25)

### Upstream merge
- **9router v0.5.55**: Adopted refreshed provider catalog, authentication, translation, streaming, and CLI packaging improvements.
- **SAML 2.0 SSO**: Added native SAML 2.0 Single Sign-On integration, IdP metadata XML & certificate uploaders, SSO protocol switcher, dynamic SAML sign-in button, and SAML user badges.
- **Providers and models**: Added Alibaba Token Plan (`token-plan.ap-southeast-1`), Kimchi dual auth (OAuth + API key), Fish Audio text-to-speech provider, `glm-5.3` for GLM Coding and GLM (China) registries, Opencode-Go transport format routing with per-model guards, and `llm7` test support.
- **Routing and translation**: Added Kiro multi-surface auth-aware endpoint routing, integrity-gate streaming, header-based interception (`x-amz-target`), `auto` model slot, and accurate output token accounting. Added early billing error detection in Qoder SSE for failover. Fixed OpenAI Responses empty `tool_calls` array premature termination (#3234) and preserved `prompt_cache_key` when converting chat to responses (#3216).
- **Quota and client handling**: Strip competitive system prompts in Antigravity to prevent 429 quota errors from Zed IDE. Forward official client headers for free-tier Opencode requests. Added 120s TTL caching and promise dedup for Claude quota calls with `?force=1` bypass for manual refresh. Re-anchored Claude passthrough cache breakpoints with 1h TTL.
- **Combos and adapters**: Vision adapter image detection from Hermes and attachment payloads; stripped `stream_options` from Fusion panel fan-out; added `api_key` parameter in Hermes YAML config.
- **Documentation and i18n**: Added Spanish (`README.es.md`), French (`README.fr.md`), and Brazilian Portuguese (`README.pt-BR.md`) documentation translations.

### Security
- **Socket peer validation**: Require proof that `x-9r-real-ip` originates from trusted local socket connections (GHSA-pjm4-8fpg-f9p6).
- **SSRF guard**: Validate and reject non-public base URLs on web/search endpoints.
- **Authentication**: Block fresh-install remote login using default password (returns 403 without issuing JWT).
- **Privacy**: Redacted sensitive payload contents on `/api/usage/request-details`.

### n9router preservation
- **State DB**: Retained lowdb (`db.json`) as the sole state persistence layer, rejecting upstream SQLite migration.
- **Fork capabilities**: Preserved MITM token pool swapping, retry classification, token cooldowns, stream watchdog controls, API-key limits, token-swap usage observer, Antigravity account-type badges, cached-token tracking, ApiKeyUsageReport, UsageFlexReport, Cursor BYOK installer, and fork branding.

## v0.4.53 (2026-08-15)

### Features
- **Antigravity Gemini 3.7 Flash**: Added `ag/gemini-3.7-flash-high|medium|low`, Gemini API `gemini-3.7-flash`, MITM aliases/slots, pricing, and capabilities.

### Fixes
- **Quota Tracker**: Antigravity now fingerprints as IDE **2.5.5**, the first client version whose `fetchAvailableModels` response includes Gemini 3.7 Flash quotas.
- **Quota parsing**: Keep the live `gemini-3.7-flash-tiered` bucket as a fallback when Google has not split high/medium/low keys.

## v0.4.52 (2026-08-08)

### Fixes
- **Cursor BYOK**: Restored the dashboard installer card and updated the installer to resolve the latest upstream `main` commit before downloading its immutable source tarball.
- **macOS Cursor BYOK**: Avoid unnecessary sudo when Cursor’s atomic-write targets are user-writable, preventing the `EPERM` install failure.

## v0.4.51 (2026-08-07)

### Upstream merge
- **9router v0.5.50**: Adopted refreshed provider, quota, pricing, OAuth, usage, dashboard, media-provider, and CLI packaging improvements.
- **Routing and translation**: Added Kiro direct Claude routing, conversation/session continuity improvements, native reasoning mapping, custom-tool Responses handling, cache-inclusive token accounting, and stronger terminal-stream handling.
- **Providers**: Added or expanded Devin CLI, Trae, Windsurf, Zed, CodeBuddy International, TokenRouter, and self-hosted embedding/STT/TTS support.

### Fixes
- **Vision Adapter**: Removing the last model now actually clears the pool and disables that adapter; enabling it again explicitly restores its default fallback model.
- **Antigravity project IDs**: Stopped proactive OAuth-refresh onboarding retries. Existing project IDs remain intact; lookup still occurs only for an explicit import/onboarding flow or a request-time cold miss.
- **Merge compatibility**: Restored Kiro session/continuation helpers and the Kiro thinking-field guard; updated background token refresh and usage-provider lookup to use n9router's lowdb persistence.

### n9router preservation
- Retained lowdb (`db.json`) as the sole state store, including MITM token swapping/retry/cooldowns, stream watchdog and `[DONE]` handling, API-key limits, usage reports, Cursor BYOK, selective import, and fork branding.

### Validation
- Added capacity-adapter model-control regression coverage; the focused test suite and production build pass.

## v0.4.50 (2026-07-18)

### Features
- **XAI Grok Imagine video**: Added OpenAI-compatible `/v1/videos/*` proxy routes, account-aware generation/polling, and the `n9router xai video` CLI command.
- **Grok Build**: Added dashboard setup/status integration, live model discovery, subscription-aware billing and quota reporting, token-expiry propagation, and current protocol support.
- **Usage and providers**: Added per-provider quota visibility controls, safer bulk API-key additions, expanded `/v1/models` capability handling, Kiro GPT-5.6 slots, and Alibaba International endpoint compatibility.
- **Token saver control**: Added a per-request bypass header for token-saver features.

### n9router merge policy
- **Preserved fork behavior**: Retained lowdb/db.json persistence, Cursor BYOK, token-pool and stream-watchdog safeguards, usage reporting, and n9router branding.
- **Excluded translation updates**: Did not adopt upstream locale updates or request-format/Kiro session-replay translator changes.

### Tests
- Added upstream coverage for XAI video, Grok Build, quota visibility, bulk API-key naming, provider updates, and Grok CLI usage.

## v0.4.49 (2026-07-11)

### Features
- **New providers**: Added Grok CLI OAuth/device-code routing, Featherless presets, Perplexity Agent API, configurable SearXNG, and updated provider/model catalogs.
- **PXPipe token saver**: Added multimodal prompt compression with dashboard controls and lifecycle, status, log, and statistics APIs.
- **Headroom**: Added extras detection, installation, restart, and app-proxied dashboard support.
- **Routing and translation**: Added per-model thinking levels, stronger OpenAI Responses multi-turn conversion, structured Anthropic token counting, and RTK git-log/Windows parsing.
- **Dashboard and i18n**: Added Farsi, expanded Chinese translations, cached-token display, and provider-model UI refinements.

### Improvements
- **Reliability**: Improved Codex fast-tier/capacity handling, provider refresh and usage tracking, Antigravity IDE fingerprinting/usage headers, and request-detail handling.
- **Coverage**: Added regression tests for Grok CLI, PXPipe, token counting, thinking levels, request details, and translator edge cases.

### n9router preservation
- **Persistence**: Rejected the upstream SQLite migration; n9router continues to use lowdb at `~/.n9router/db.json`.
- **MITM and streaming**: Retained token-swap cooldown/retry behavior, watchdog controls, terminal `[DONE]` handling, and raw-source MITM runtime packaging.
- **Fork capabilities**: Retained Cursor BYOK, selective database import, usage reporting, API-key limits, MoMo donations, and n9router branding.

## v0.4.48 (2026-07-06)

### Fixes
- **MITM lock contention**: Reverted the `.mitm.lock` file introduced by the security-audit patch. A crash or kill during startup could leave a stale lock that permanently blocked both auto-start and manual Start with "MITM server is already starting (lock contention)". Startup now guards on the in-process handle and PID file, as it did before.

## v0.4.47 (2026-07-05)

### Features
- **Cursor BYOK installer**: Added a guided CLI installer for bringing your own API key to Cursor, with step-by-step process cards, step indicators, and a quick-guide reference section.
- **Cursor BYOK Windows support**: Implemented the full BYOK workflow on Windows including UAC elevation handling and restore-state management.
- **Cursor BYOK macOS hardening**: Implemented secure macOS code-signature validation for the BYOK workflow and improved restore-state management.

### Improvements
- **Dashboard navigation**: Added a MITM proxy navigation link to the dashboard sidebar for easier access to proxy settings.
- **Endpoint page**: Updated the endpoint page UI.


## v0.4.46 (2026-07-04)

### Fixes
- **ClinePass connection tests**: Added ClinePass OAuth/API-key validation support so dashboard provider tests no longer report unsupported or invalid credentials when real requests work.
- **ClinePass model tests**: Normalized successful ClinePass `data.choices` response envelopes into standard OpenAI `choices`, fixing false “Provider returned no completion choices” errors in the model test UI.

### Tests
- Added regression coverage for ClinePass provider validation and non-streaming response-envelope normalization.

## v0.4.45 (2026-07-04)

### Features
- **Provider registry**: adopted the unified `open-sse/providers/registry/*` model/capability/pricing/auth registry and moved pricing resolution to `open-sse/providers/pricing.js`.
- **New and expanded providers**: added or updated ClinePass, Kimchi, CodeBuddy CN, MiMo Free, Venice AI, Vercel AI Gateway, Blackbox, and NVIDIA provider support.
- **Media providers**: added image generation, TTS, STT, media-provider dashboard pages, and `/v1/audio/*`, `/v1/images/generations`, `/v1/search`, and `/v1/web/fetch` route support.
- **Headroom and token saver**: added Headroom lifecycle APIs/dashboard support, Docker sidecar support, token-saver dashboard, and safer Responses compression handling.
- **Ponytail**: added the minimalist code-generation RTK feature.
- **Combo routing**: added Fusion strategy, per-combo strategy selection, capacity auto-switching, and improved custom-provider model visibility.
- **Codex**: added bulk account import, reset-credit expiry details, opt-in quota auto-ping, better Responses terminal handling, custom-tool preservation, and reasoning-effort preservation.
- **Kiro**: added headless API-key auth, direct Claude↔Kiro routing, external IdP/Microsoft SSO import, IDC token import, multi-endpoint failover, Claude Sonnet 5 support, and regional IdC routing.
- **Usage and quota**: added cached-token tracking, corrected input/output/cache cost calculation, deduped streaming request-detail logs, and reduced streaming usage double-counting.
- **Security and hardening**: adopted SSRF protections, DB export/import re-auth, remote default-password guard, real client-IP rate limiting, and Kiro region validation.
- **CLI and packaging**: adopted Next.js 16 nested standalone output handling, Docker Compose support, Windows tray DPI improvements, and JSONC-tolerant CLI settings routes.

### Fixes
- Fixed n9router-compatible provider creation after the upstream registry merge by restoring the missing `AI_PROVIDERS` import in `/api/providers`.
- Kept fork Antigravity usage/tier quota behavior, configurable Kiro/Antigravity retry behavior, stream `[DONE]` sentinel behavior, and pricing import compatibility after the upstream pricing move.

## v0.4.44 (2026-07-04)

### Features

- **Selective database import**: Added granular import controls for merging or replacing supported settings and provider data.
- **Upstream v0.4.71 providers and models**: Added Xiaomi MiMo V2.5 Pro routing, Qoder latest-model discovery/import, and MiniMax-M3 model, pricing, and quota support.
- **Caveman and localization**: Added Wenyan classical-Chinese Caveman levels, locale-based visibility, translated endpoint exposure notices, and a Russian README.

### Improvements

- **Release pipeline**: Added native AMD64/ARM64 Docker builds, digest-based manifest publishing, optional npm publishing, and manual release-tag support.
- **Offline builds**: Self-hosted the Inter font to remove the Google Fonts dependency from Docker and CI builds.
- **Dashboard and test coverage**: Reorganized language/menu/profile actions and expanded translator, provider, and real-provider smoke-test coverage.

### Fixes

- **Codex reliability**: Hardened streaming timeouts and terminal events, preventing hanging clients, and improved OAuth token refresh durability.
- **Kiro and Claude compatibility**: Fixed Kiro binary EventStream handling, tool-bearing history, model/TTS filtering, and Claude OAuth `tool_choice` requests.
- **Routing and infrastructure**: Corrected image/STT model tests, MiniMax reasoning follow-ups, Antigravity autocomplete, provider connection guards, tunnel interface detection, and configurable proxy uploads up to 128 MB.

## v0.4.43 (2026-06-05)

### Fixes

- **MITM Antigravity auth refresh**: Token refresh now uses the existing internal CLI token header to call the provider test route, keeping a single refresh path while avoiding `401 Unauthorized` from dashboard auth.
- **Auth refresh retries**: Token-swap auth refresh failures now retry up to 3 times before falling back to cooldown and next-account selection.
- **Refresh diagnostics**: Refresh attempts now log token lifetime in local time and surface the underlying refresh failure details instead of giving a generic failure.

### Improvements

- **Token swap visibility**: Dashboard token pool cards now show cooldown timing next to the active badge for accounts under cooldown.

### Tests

- Added coverage for Antigravity internal refresh calls, auth refresh failure logging, and retry behavior.

## v0.4.42 (2026-06-03)

### Fixes

- **OAuth token refresh reliability**: MITM token-pool refresh now handles connections with a refresh token but no `expiresAt`, and forced auth refreshes bypass still-valid expiry timestamps.
- **Connection test refresh flow**: Provider connection tests can now request a forced refresh and report whether new tokens were applied.
- **Token Rotation account toggles**: Toggling a pool account active/inactive no longer refetches quota data for every account.

### Tests

- Added token-pool coverage for missing-expiry refreshes and forced refresh requests.

## v0.4.41 (2026-06-03)

### Improvements

- **Token-swap toggle behavior**: Token swap now follows the global `tokenSwapEnabled` setting without requiring currently active provider connections.

### Fixes

- **Manual update command**: Corrected the dashboard update instructions to restart with `n9router` instead of `9router`.

### Tests

- Updated token-pool coverage for the global token-swap toggle behavior.

## v0.4.40 (2026-06-02)

### Fixes

- **MITM token swap retries on upstream 500s**: Antigravity token-swap requests now treat HTTP 500 as retryable instead of logging the response as a success, so the pool can move on to the next account after retry exhaustion.

## v0.4.39 (2026-05-30)

### Features

- **Stream Watchdog toggle**: New `streamWatchdogEnabled` setting (default ON) to opt out of SSE stall detection. When OFF, reverts to v0.4.35 legacy streaming (no stall abort, no `[DONE]`-on-abort sentinel, no Kiro keepalive). Addresses reasoning model regressions where Kiro claude-opus-4.8-thinking pauses mid-stream during server-side reasoning and was being killed by the 30s stall watchdog. Toggle available in dashboard Profile settings.

## v0.4.38 (2026-05-30)

### Fixes

- **Streaming requests no longer hang or return truncated results**: Fixed three issues in the SSE path that caused completions (notably Kiro `claude-opus-4.8` with thinking) to never finish.
  - **Kiro stall false-trigger**: The watchdog measured Kiro's transformed output instead of raw upstream activity, so reasoning prefill looked like a stall and aborted healthy streams. Kiro's transform now emits a keepalive on raw-byte activity.
  - **Truncated streams hung clients**: On abort/stall/reset the transform's `flush()` is skipped, so terminal `data: [DONE]` was never sent. `createDisconnectAwareStream` now emits it before closing (guarded against double-emit on graceful EOF).
  - **Kiro connect hang**: `KiroExecutor.execute` skipped `FETCH_CONNECT_TIMEOUT_MS`; a connection that never returned headers hung indefinitely. It now applies the same connect timeout as `base.js`.

### Tests

- Added `tests/unit/streamHandler.test.js` covering the terminal-sentinel safety net (abort/stall/reset injection, no double-emit on EOF, passthrough).

## v0.4.37 (2026-05-30)

### Fixes

- **DATA_DIR permissions**: Entrypoint script now dynamically sets permissions for custom `DATA_DIR` paths so non-default storage locations work in Docker.
- **API key rate-limit UI**: Restored the rate-limit controls in the endpoint settings (`EndpointPageClient.js`) that were orphaned during the upstream 0.4.66 merge.

### Improvements

- **Docker workflow**: Simplified the publish workflow by removing GHCR support and updating the image tagging strategy.

## v0.4.36 (2026-05-29)

### Features

- **Support "Today" period in usage statistics**: Enhanced report query logic in `usageDb.js` to handle local today timezone bucketing and hourly granularity from midnight.
- **OIDC Dashboard Authentication**: Integrated support for OpenID Connect (OIDC) authentication flows (`/api/auth/oidc/*` endpoints) to secure/standardize dashboard access.
- **Cowork MCP Marketplace integration**: Exposes local MCP plugins bridge (`/api/mcp/*` endpoints) and marketplace modal matching upstream Cowork directory.
- **Enhanced tunnel subsystem**: Restructured the cloudflared and tailscale tunnel modules into clean subdirectories (`src/lib/tunnel/cloudflare`, `src/lib/tunnel/tailscale`).
- **Proxy Pool Deployment Tools**: Added proxy deployment support for Cloudflare Workers and Deno Deploy (`/api/proxy-pools/cloudflare-deploy`, `/api/proxy-pools/deno-deploy`).
- **One-by-One Connection Validation**: Enhanced provider key/credential validation with one-by-one verification.
- **Provider OAuth Service**: Added authentication/token refresh services for xAI and Codex.

### Improvements

- **Merge upstream 9router v0.4.66**: Adopted CLI tool card refactoring (`ApiKeySelect`/`BaseUrlSelect`), provider searching, bulk key pasting, and new provider/model metadata, while rejecting the SQLite state database migration (keeping the fork's local lowdb `db.json` structure).
- **Provider Connection sorting**: Default connection listing to sort by provider name, then sub-sort by name/email.
- **Unit test coverage expansion**: Added robust testing for reasoning injectors, minimax TTS/usage, qoder encoding, OIDC auth, and today's usage statistics.

## v0.4.35 (2026-05-28)

### Features

- Display Antigravity account tier badge (Free, Plus, Pro, Ultra) in the Quota Tracker dashboard connection card

### Improvements

- Filter and limit Antigravity model quotas to specifically keep only: `claude-opus-4-6-thinking`, `claude-sonnet-4-6`, `gemini-3.1-pro-*`, and `gemini-3.5-*`
- Add `"restricted"` check to `isTierNormalizeable` helper in the Open-SSE usage service, resolving a pre-existing unit test failure and correctly badge restricted subscription plans

## v0.4.34 (2026-05-25)

### Improvements

- Update Antigravity model IDs and display labels from the latest MITM config response
- Align Antigravity MITM default models, model aliases, and quota ordering with the latest recommended agent models
- Map the Antigravity `gemini-default` MITM synonym to `gemini-3.5-flash-low`

## v0.4.32 (2026-05-23)

### Features

- Add support for Antigravity AGYv2 by introducing path requirement checks and dedicated API routes
- Add separate controls and endpoints to monitor and close Antigravity AGYv2 processes
- Implement path requirement checks in `detectAntigravityInstallation` to accurately distinguish AGYv2 from legacy AGYv1 bundles

### Improvements

- Add comprehensive unit tests for AGYv2 layout detection and path requirements validation

## v0.4.31 (2026-05-23)

### Features

- Add separate controls and endpoints to monitor and close standard Antigravity AGY and Antigravity IDE
- Automatically set and unset the `NODE_EXTRA_CA_CERTS` environment variable on MITM server start/stop (macOS via `launchctl`, Windows via `setx`)

### Improvements

- Comment out verbose token-swap project rewrite logs in the MITM server

## v0.4.30 (2026-05-13)

### Features

- Add **Usage Flex Report** — exportable social-share card for API key usage metrics with configurable presets (1080×1080 canvas, copy-to-clipboard, PNG export)
- Add `UsageFlexCard` and `UsageFlexReport` components with multi-preset support covering tokens, cost, requests, and model breakdown views

### Improvements

- Refactor account toggling and quota refreshing states from booleans to `Set` objects in `TokenSwapPoolCard` to support concurrent per-account operations without race conditions

## v0.4.29 (2026-05-10)

### Features

- Add CommandCode provider support with OpenAI request/response translators, executor registration, provider icon, and unit coverage
- Add Cloudflare Workers AI image generation support with model metadata and provider routing
- Add Cowork MCP registry endpoint and support for custom Cowork host credentials in CLI tool settings
- Add `/v1/audio/voices` and `/v1/models/info` compatibility endpoints
- Add CapRover deployment definition and Chinese README translation

### Improvements

- Refactor connection proxy configuration logic for clearer proxy option handling
- Improve CLI tool endpoint selection with shared `BaseUrlSelect` and cloud endpoint matching helpers
- Update DeepSeek pricing and add DeepSeek V4 Pro model metadata
- Expand combo/model selection UI with model deselection support

### Fixes

- Normalize Ollama Local provider input before validation and provider persistence
- Prevent cached settings API responses so dashboard settings stay current
- Fix localized README links
- Improve compatible provider API key setup validation

## v0.4.28 (2026-05-10)

### Improvements

- Migrate Docker runtime to Node.js for production startup compatibility
- Require the current `HEAD` to be tagged as the matching release version before Docker publishing
- Optimize dashboard usage tab switching and standardize token usage display logic
- Standardize usage tracking stream accounting output

## v0.4.27 (2026-05-09)

### Features

- Add Antigravity Payload Guard to restrict protected provider access and surface safer token-swap errors
- Add multi-arch Docker publishing script with Docker Hub workflow support and `npm run publish:docker` commands
- Add Antigravity MITM token-swap project ID rewrite controls

### Improvements

- Improve Antigravity token-swap pool health indicator behavior
- Make project ID rewriting unconditional for Antigravity token-swap requests
- Add token-swap diagnostics for project ID rewrite handling

### Fixes

- Rewrite Antigravity token-swap project IDs in request bodies to avoid `403 PERMISSION_DENIED`

## v0.4.26 (2026-05-06)

### Features

- Add **Usage Reports tab** with multi-dimensional analytics: period × metric × breakdown × granularity
- Add **All / API Key / Model / Provider** breakdown selector — "All" shows aggregate trend with all three top-contributors charts simultaneously
- Add **Today** period option — uses local midnight-to-now as a custom time range with automatic hourly granularity
- Add **Day / Week / Month** chart granularity control — hidden for Today/24H which always use hourly buckets
- Add monthly chart bucketing in the report aggregator (`interval=month`, labels like "May 2026")
- Add compact usage/quota display in API Keys table with color-coded badges (green/amber/red) showing 5h/24h tokens and cost usage
- Add inline API key name editing with pencil icon on hover (Enter to save, Escape to cancel)
- Add custom time windows for rate limits — configure limits beyond 5h/24h (15min, 1h, 6h, 12h, 24h, 7d, 30d)
- Add CustomWindowsEditor in KeyLimitsEditor for adding/removing custom time windows with token/cost limits
- Show API key names in CLI Tools dropdowns alongside key values (format: `sk-...xxxx (name)`)
- Add API key usage reset feature — admins can reset usage for specific time windows (All time / 5h / 24h / 7d / 30d) with confirmation popup
- Add reset history tracking — logs all usage reset events with tokens/cost cleared and timestamp, viewable in limits editor

### Improvements

- Auto-fetch usage data for keys with limits on dashboard load
- Extended usage data retention to 30 days to support monthly window tracking
- Add `validateWindow()` helper and `PREDEFINED_DURATIONS` export in usageLimiter.js

### Fixes

- Return proper 429 rate limit error with descriptive message when API key exceeds any configured limit (legacy 5h/24h or custom windows)
- Fix "All" breakdown not aggregating series — `_getSeriesLabel` now returns `"total"` for `seriesBy=none`
- Fix Today chart showing no data — chart data now fills all series keys with `0` to avoid recharts skipping undefined stacked areas
- Fix 24H period not using hourly granularity — Today and 24H now automatically force `interval=hour`

## v0.4.25 (2026-05-05)

### Features

- Add STT (Speech-to-Text) support with multiple providers (Edge TTS, ElevenLabs, Google TTS, OpenAI, OpenRouter, Local Device)
- Add Gemini TTS integration and expand usage tracking with additional metrics
- Add Skills feature for reusable AI interaction patterns
- Add browser-local endpoint presets for CLI tools
- Add RTK compression filter in the request path, applied just before provider dispatch
- Add Caveman prompt injection controls for Gemini-compatible requests
- Add OpenCode Go provider support with custom models
- Add Azure OpenAI provider support with built-in model metadata
- Add built-in Volcengine Ark provider support
- Add Grok Web and Perplexity Web providers
- Add Xiaomi MiMo provider support
- Add Hermes tool to CLI tools with updated components
- Add review model quota support for Codex
- Add sticky round-robin support for combo routing

### Improvements

- Refactor global styles and enhance MITM functionality
- Refactor proxyFetch and enhance MediaProviderDetailPage layout
- Refactor token refresh logic and improve MITM server handling
- Enhance mobile layouts and restore Cloudflare provider
- Improve zh-CN translations
- Add API key setup URLs across provider cards and improve responsive dashboard layouts
- Add cached-token usage metrics and richer provider limit/topology displays
- Move RTK compression to the final dispatch body for both translated and native passthrough requests
- Support custom host URL for remote Ollama servers

### Fixes

- Strip stream_options for Qwen non-streaming Claude Code requests
- Preserve reasoning_effort for non-Claude models in GitHub provider
- Update Qwen OAuth URLs from chat.qwen.ai to qwen.ai
- Force Agent mode in Cursor protobuf when User-Agent contains Claude Code
- Prevent SSE listener leak in console-logs stream
- Redirect ~/.9router to DATA_DIR in Docker to persist usage data across updates
- Gate sudo prompts on server platform in MITM
- Fix custom provider prefix conflicts with built-in alias
- Normalize Claude text-only content arrays to OpenAI-safe strings
- Strip unsupported Anthropic output_config for MiniMax Claude-compatible requests
- Merge Antigravity tool declaration groups into a single Gemini-compatible group
- Cap maximum cooldown for rate limit handling in account unavailability

## v0.4.24 (2026-05-02)

### Features

- Add Xiaomi MiMo provider support with built-in model metadata, validation endpoint, and provider icon
- Add Caveman prompt injection controls in the RTK request path, applied just before provider dispatch
- Add sticky round-robin support for combo routing so each combo model can receive multiple requests before rotating

### Improvements

- Move RTK compression to the final dispatch body so it works for both translated and native passthrough requests
- Add API key setup URLs across provider cards and improve responsive dashboard layouts for CLI tools, providers, usage, profile, and endpoint pages
- Add cached-token usage metrics and richer provider limit/topology displays in the usage dashboard

### Fixes

- Normalize Claude text-only content arrays to OpenAI-safe strings and parse raw NDJSON stream lines without requiring an explicit Ollama format
- Strip unsupported Anthropic `output_config` for MiniMax Claude-compatible requests while preserving it for Anthropic
- Merge Antigravity tool declaration groups into a single Gemini-compatible group before token-swap dispatch

## v0.4.23 (2026-05-02)

### Fixes

- Treat Antigravity MITM token-swap `403` IAM permission errors as retryable account fallback events, matching the existing `429`/`503` retry path

## v0.4.21 (2026-04-30)

### Features

- Add Antigravity host rewrite setting to avoid rate limits — toggle in Profile settings rewrites upstream host on each request

### Improvements

- Centralize MITM settings into a dedicated `mitmSettings.js` module for cleaner settings management
- Refactor `MitmToolCard` with a `DnsToggleButton` sub-component, improved DNS toggle UI, and abort signal support in fetch logic
- Refactor Antigravity logging to use consistent terminology and clear forced passthrough model list

### Fixes

- Rewrite Antigravity MITM handler to use direct `fetchRouter`/`pipeSSE` pipeline with proper SSE and non-SSE error responses — prevents SDK from hanging when an error occurs mid-stream

## v0.4.20 (2026-04-29)

### Features

- Add Antigravity MITM token-swap IDE version override with Profile settings toggle and configurable version, defaulting to `1.23.2`

### Improvements

- Rewrite both Antigravity request `metadata.ideVersion` and `user-agent` version when the override is enabled
- Route `/v1internal:loadCodeAssist` through Antigravity MITM token swap so eligibility-check requests can use the override
- Add a Profile settings notice that IDE version spoofing is used at your own risk

## v0.4.16 (2026-04-24)

### Features

- Add hourly `db.json` backups with 3-day retention and a Profile settings toggle enabled by default

### Fixes

- Prevent token-swap DB writes from racing normal local DB writes by using shared locking and atomic JSON updates
- Stop resetting `db.json` to defaults on corrupt JSON; restore from a valid backup or preserve the corrupt file for recovery

## v0.4.15 (2026-04-24)

### Features

- Add Azure OpenAI provider support
- Add built-in Volcengine Ark provider support (#741)
- Add GPT 5.5 model
- Add Hermes CLI tool with settings management and integration
- Add in-app version update mechanism (appUpdater + /api/version/update)

### Improvements

- Strengthen CLI token validation for enhanced security
- Enhance Sidebar layout for CLI tools
- Update executors and runtime config

### Fixes

- Enhance retry logic and configuration for HTTP status codes

## v0.4.14 (2026-04-23)

### Features

- Integrate RTK (Token Killer) compression into the MITM token-swap path — large tool outputs (git-diff, grep, ls, etc.) are now compressed before forwarding to upstream providers, reducing token usage by ~7% on real workloads

## v0.4.12 (2026-04-23)

### Features

- Add RTK — filter context (ls/grep/find/...) before sending to LLM to save tokens
- Add OpenCode Go provider and support for custom models
- Add Text To Image provider
- Support custom host URL for remote Ollama servers

### Fixes

- Fix copy to clipboard issue

## v0.4.11 (2026-04-23)

### Features

- Add per-account request health monitor in MITM Token Swap dashboard — last 100 calls displayed as colored 6×6px squares (green = success, orange gradient = retry success, red = fail) with live summary counts and hover tooltips
- Persist health history to `~/.n9router/account-health.json`; survives server restarts; polled every 10s in the dashboard

### Improvements

- Treat Antigravity 429 and 503 errors identically — both now retry the same account with exponential backoff (shared `_quotaRetryCount` counter, reuses per-account retry count setting)
- Apply cooldown/strike only after **2 consecutive fail** health events; a single 429/503 burst skips the account without penalising it, reducing false-positive cooldowns from Antigravity's random error responses

## v0.4.8 (2026-04-19)

### Features

- Add Kiro AWS Identity Center device flow for provider OAuth (`b1288c5`)
- Add marked package for Markdown rendering and enhance changelog styles (`75c4598`)
- Add TTS (Text-to-Speech) core handler and TTS models config
- Add suggested models API endpoint
- Add proactive token refresh lead times for providers and Codex proxy management (`04cdb75`)
- Add Blackbox AI as a supported provider (#599) (`3badf1c`)
- Add multi-model support for Factory Droid CLI tool (#521) (`1d872ce`)
- Add GLM-5 and MiniMax-M2.5 models to Kiro provider (#580) (`aa67198`)

### Improvements

- Refactor error handling to config-driven approach with centralized error rules (`b669b6f`)
- Refactor localDb and usageDb for cleaner structure (`75ad0be`)
- Update Qwen executor for OAuth handling (`75c4598`)
- Enhance error formatting to include low-level cause details (`3977edc`)
- Refactor HeaderMenu to use MenuItem component for better structure (`3977edc`)
- Improve LanguageSwitcher to support controlled open state (`3977edc`)
- Update backoff configuration and improve CLI detection messages (`6ab9927`)
- Add installation guides for manual configuration in tool cards (Droid, Claude, OpenClaw) (`6ab9927`)
- Enhance Windows Tailscale installation with curl support and well-known Windows path fallback (`6bec1e0`)
- Refactor execSync and spawn calls with windowsHide option for better Windows compatibility (`1fa05eb`)
- Auto-build Docker image on tag push (#547) (`befb2bc`)

### Fixes

- Fix Codex image URL fetches to await before sending upstream (#575) (`d0ace2a`)
- Strip thinking/reasoning_effort for GitHub Copilot chat completions (#623) (`afe09f3`)
- Show quota auth expired message for Kiro social auth accounts (#588) (`2e8784c`)
- Enable Codex Apply/Reset buttons when CLI is installed (#591) (`877b744`)
- Show manual config option when Claude CLI detection fails (#589) (`f27db54`)
- Show manual config option when OpenClaw detection fails (#579) (`63dbf89`)
- Ensure LocalMutex acquire returns release callback correctly (#569) (`dac6c39`)
- Strip enumDescriptions from tool schema in antigravity-to-openai (#566) (`6e8aaab`)
- Strip temperature parameter for gpt-5.4 model (#536) (`554bbfc`)
- Fix noAuth support for providers and adjusted MITM restart settings (`6a6e2fc`)
- Fix usage tracking bug (`75ad0be`)

## v0.4.7 (2026-04-14)

### Features

- Enhance provider models and chat handling with new thinking configurations (`4c28a16`)
- Enhance proxy functionality with Vercel relay support (`89eb26d`)
- Enhance TTS functionality and security settings (`b3feb96`)

### Improvements

- Update GitHub Actions workflow for Docker image (`ee1271b`)
- Parameterize Bun image and improve package management in Dockerfile (`7887f4f`)
- Update Docker build process and documentation (`5d3780c`)
- Add Docker support and improve Dockerfile configuration (`d99f63c`)

### Docs

- Update README with new Antigravity Token Swap tutorial video (`177e8c9`)
- Update star chart link to reflect repository migration (`8996eff`)

## v0.4.5 (2026-04-11)

### Fixes

- Fix: update Tailscale directory paths from `.9router` to `.n9router` (`3d68aeb`)

## v0.4.3 (2026-04-11)

### Features

- Add Tailscale remote access support (`ed17a8f`)
- Add TTS (text-to-speech) endpoint support (`3c96e8d`)
- Multi-model support for OpenCode CLI config with subagent integration (`1a25c6e`)
- CLI: add `--update` and `--version` flags, and startup version announcement (`6fbeef4`)

### Improvements

- Replace sticky round-robin with least-recently-used (LRU) connection selection strategy (`6d11114`)
- Improve Windows Antigravity DNS error handling (`e289908`)

### Fixes

- Add 5s timeout to `fetchCompatibleModelIds` and skip upstream connections (#541) (`838d9a7`)
- Only strip `reasoning_content` when content is non-empty (#542) (`878cdf3`)
- Enable Apply button when models are selected (`f8a2677`)
- Fix OpenRouter custom models not showing after being added (`507a5db`)
- Fix combo modal (`39545cf`)

## v0.3.99 (2026-04-09)

### Features

- Persist model quota status and hard-filter exhausted accounts in token pool (`ce713e4`)
- Implement antigravity account type inference, local quota fallback, and UI badges (`3b5a5b7`)
- Implement immediate cooldown logic for capacity exhaustion and human-readable reset time formatting (`ecc4a4d`)
- Token Swap Pool feature with rotating token support (`737012f`)

### Improvements

- Centralize `formatResetTimeDisplay` utility and update quota reset logic in TokenSwapPoolCard (`df73cd7`)
- NPM release packaging (`81e5101`)

### Fixes

- Simplify sudo password validation in AntigravityToolCard, MitmServerCard, and MitmToolCard (`db85dd2`)

### Docs

- Add Token Swap Pool feature to README (`199940a`)

## v0.3.96 (2026-04-17)

### Features

- Add marked package for Markdown rendering
- Enhance changelog styles

### Improvements

- Refactor error handling to config-driven approach with centralized error rules
- Refactor localDb structure
- Update Qwen executor for OAuth handling
- Enhance error formatting to include low-level cause details
- Refactor HeaderMenu to use MenuItem component
- Improve LanguageSwitcher to support controlled open state
- Update backoff configuration and improve CLI detection messages
- Add installation guides for manual configuration in tool cards (Droid, Claude, OpenClaw)

### Fixes

- Fix Codex image URL fetches to await before sending upstream (#575)
- Strip thinking/reasoning_effort for GitHub Copilot chat completions (#623)
- Enable Codex Apply/Reset buttons when CLI is installed (#591)
- Show manual config option when Claude CLI detection fails (#589)
- Show manual config option when OpenClaw detection fails (#579)
- Ensure LocalMutex acquire returns release callback correctly (#569)
- Strip enumDescriptions from tool schema in antigravity-to-openai (#566)
- Strip temperature parameter for gpt-5.4 model (#536)
- Add Blackbox AI as a supported provider (#599)
- Add multi-model support for Factory Droid CLI tool (#521)
- Add GLM-5 and MiniMax-M2.5 models to Kiro provider (#580)
- Fix usage tracking bug

## v0.3.91 (2026-04-15)

### Features

- Add Kiro AWS Identity Center device flow for provider OAuth
- Add TTS (Text-to-Speech) core handler and TTS models config
- Add media providers dashboard page
- Add suggested models API endpoint

### Improvements

- Refactor error handling to config-driven approach with centralized error rules
- Refactor localDb and usageDb for cleaner structure

### Fixes

- Fix usage tracking bug

## v0.3.90 (2026-04-14)

### Features

- Add proactive token refresh lead times for providers and Codex proxy management
- Enhance CodexExecutor with compact URL support

### Improvements

- Enhance Windows Tailscale installation with curl support and fallback to well-known Windows path
- Refactor execSync and spawn calls with windowsHide option for better Windows compatibility

### Fixes

- Fix noAuth support for providers and adjusted MITM restart settings
- Bug fixes

## v0.3.89 (2026-04-13)

## v0.3.83 (2026-04-08)

### Fixes

- Fix unauthenticated server shutdown endpoint security vulnerability (#519) (`1f3d3a8`)
- Merge consecutive `userInputMessages` in openai-to-kiro translator (#524) (`23abe1a`)
- Update Cursor client version to 3.1.0 for Composer 2 compatibility (#525) (`32a7461`)
- Strip `reasoning_content` from non-streaming responses (#517) (`a53ccf1`)
- Make API key optional for ollama-local provider validation (#493) (`7db4b98`)
- Update `/v1/models` to support OpenAI/Anthropic Compatible providers (#497) (`ebb8d4e`)
- Sync top-level copilotToken after proactive refresh (#507) (`6ec5890`)
- Fix ModelSelectModal (`57cfacc`)
- Updated Anthropic-Beta header (`67e0db7`)
- Strip image bug fixes (`401772c`)

## v0.3.75 (2026-04-05)

### Features

- Translator: lossless passthrough via CLI tool + provider pairing (`666aecf`)
- Embedding support (`5448eed`)
- Add GitLab Duo and CodeBuddy support, update observability settings (`abbf8ec`)
- Add OpenCode provider support (#387) (`fcc8320`)
- Expand OpenAI and Gemini static model lists (#398) (`56be393`)
- Add Google Cloud Vertex AI provider support (`39f651f`)
- Add Kiro MITM support (`03ff351`)
- Add MiniMax M2.7 model support (#357) (`a0500df`)
- Add Basic Chat interface for testing models (`6b0cced`)
- Add per-combo round-robin strategy (`3e694a3`, `96f5e5c`)
- Add multi-language support for UI (`11c6b0c`)
- Fetch free models from Kilo API + Windows build fixes (#455) (`8640503`)
- Claude Code: spoof TLS fingerprint and stabilize headers for Anthropic (`1c160cc`)
- Auto restart after crash (`adae260`)
- Add optional modelID input for custom API Key Providers testing (#315) (`65af432`)

### Improvements

- Enhance passthrough function to support response inspection (`fd4ec9e`)
- Enhance image support in Kiro for Claude models (`8df8b94`, `4496bf9`)
- Refactor error logging to provide clearer context on provider failures (`f264bb9`)
- Update MITM bypass logic and enhance combo name validation (`f1c53a3`)

### Fixes

- Correct thought signatures for AG, Gemini CLI, Vertex; fix missing Vertex response translator (`1973fe5`)
- Fix Qwen provider (`2b1faeb`)
- Pass `isFree` prop to ModelRow for custom models (#480) (`2e740ad`)
- Pass HOME explicitly in sudo inlineCmd so MITM server resolves correct data dir (#482) (`7f4f75a`)
- Skip `function_call` items with empty/missing name to prevent Codex 400 error (#487) (`5fe2c81`)
- Retry `/responses` endpoint when GitHub returns model not supported (#488) (`38eabae`)
- Use `which` instead of `command -v` for openclaw CLI detection (#489) (`006c337`)
- Emit closing `</think>` tag instead of empty `reasoning_content` (#454) (`ffa172c`)
- Preserve `thoughtSignature` via `tool_call` ID smuggling + fix ELOCKED mutex (`054facb`)
- Handle anthropic-compatible providers in BaseExecutor (#428) (`8335488`)
- Add missing `clientId` to GitHub provider config for OAuth token refresh (#442) (`cd1e06b`)
- Correct `finish_reason` for tool calls in OpenAI Responses translator (`11e6004`)
- Use project-scoped Vertex URL for SA JSON auth and add `?alt=sse` for streaming (#388) (`f05d64e`)
- Inject placeholder message when Responses API `input[]` is empty (#419) (`5abf710`)
- Map OpenAI `image_url` data URLs to Ollama `images[]` (#432) (`4e631c4`)
- Strip `functionCall`/`functionResponse` id and synthetic `thoughtSignature` for Vertex AI (#414) (`e3a7733`)
- Use better-sqlite3 for Cursor auto-import, drop sqlite3 CLI requirement (#411) (`a6c764d`)
- Add deprecation warning for Gemini CLI provider (#406) (`2f0fd34`)
- Sanitize Gemini function names to meet API requirements (#403) (`ade3f57`)
- Detect Claude format for `/v1/messages` + sanitize tool descriptions (#397) (`3b4184b`)
- Clamp Responses API `call_id` to 64 chars (#396) (`868eabf`)
- Support HTTP/HTTPS image URLs in Claude and Gemini translators (#344) (`99cb9ed`)
- Inject `stream_options` for usage data in iFlow streaming (`e9ccae4`)
- Verify Cursor installation on Linux before auto-import (`8312af7`)
- Test Codex connection against actual endpoint (#347) (`97f2a00`)
- Prevent duplicate model aliases on import (#340) (`1ed6c4c`)
- Skip disabled providers in combo fallback instead of returning 406 (#336) (`037d013`)
- Normalize `finish_reason` to `tool_calls` when tool calls are present (#379) (`01e4a28`)
- Treat Kiro 400 'improperly formed request' as model-unavailable (#386) (`b8918c0`)
- Pick last non-empty message for Codex Responses SSE (`3d4dbdc`)
- Combo 503 cooldown wait before fallthrough + 406 on disabled creds (#382) (`4774150`)
- Fix MITM for Docker and enhance Dockerfile (#381) (`8c0b4a3`)
- Add missing `type:string` to enum properties in Gemini tool schema translation (#380) (`4d7ddbf`)
- Clean JSON schemas for Gemini function declarations (#371) (`1154244`)
- Remove sql.js dependency from Cursor auto-import route (#368) (`3f85277`)
- Restore provider assets and model availability endpoint (#367) (`9fe4726`)
- Track lifetime request total beyond history cap (#366) (`5fedcad`)
- Fix tunnel issues (`6af8043`, `80583e2`)
- Externalize better-sqlite3 for Next.js standalone builds (`34013b5`)
- Docker: use entrypoint to fix `/app/data` permissions on mounted volumes (`8c51eda`)
- Docker: move data dir chown after COPY to fix EACCES permission error (`9c757ff`)
- Fix abort method in `pipeWithDisconnect` to return a promise (`6b624af`)
- Add proper-lockfile for safe database read/write operations (`8759545`)
