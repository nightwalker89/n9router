# Changelog

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
