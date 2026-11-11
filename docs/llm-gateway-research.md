# LLM Gateway / Router Research — micky-assistant

**Goal:** Find the best open-source LLM gateway/router (late 2025/2026) for routing
requests across **Groq, Gemini, Mistral, OpenRouter, Cloudflare Workers AI** from a
**Cloudflare Worker (TypeScript)**. Must handle multi-provider routing, rate-limit
tracking, failover, streaming normalization, BYOK secret management, sticky sessions,
and circuit breakers. **Edge-compatible (no Node-only deps) is critical.**

**Context discovered:** The micky-assistant Worker currently uses `itty-router` +
`wrangler.toml` + `wrangler secret put`, and only calls Cloudflare Workers AI
(`@cf/qwen/...`). This Next.js repo is the frontend that proxies to that Worker.

---

## TL;DR — Recommendation

| Rank | Tool | Why | Fit for CF Workers |
|------|------|-----|--------------------|
| 🥇 | **Portkey AI Gateway** | Only major OSS gateway that **natively deploys to Cloudflare Workers** (built on Hono, ships `wrangler.toml`). Supports all 5 target providers (Groq, Gemini, Mistral, OpenRouter, Workers AI). MIT. 122 kB, <1 ms. | ✅ In-Worker |
| 🥈 | **Cloudflare AI Gateway** (managed, free tier) | Native CF product for rate-limit tracking, caching, fallback, analytics — complements any router. Not OSS, but zero-ops. | ✅ Native |
| 🥉 | **LiteLLM** (as external sidecar) | Most feature-complete (auto-router, budgets, virtual keys, observability). Can't run *in* the Worker — Worker proxies to it. | ⚠️ Sidecar |

**Honorable edge-native mention:** `MoyuFamily/ai-relay` (132★, TS, MIT) — tiny, built for
CF Pages/Workers with D1+KV, explicitly advertises *circuit breaking*. Good if you want a
minimal hand-rolled alternative.

---

## Full Candidate Comparison

All data verified via GitHub API + raw README fetches (Nov 2026).

| # | Tool | Stars | Lang | License | Last push | Multi-provider | Streaming | Fallback/Retry | Rate-limits | BYOK | CF Workers? | Free/OSS |
|---|------|-------|------|---------|-----------|----------------|-----------|----------------|--------------|------|-------------|----------|
| 1 | [BerriAI/litellm](https://github.com/BerriAI/litellm) | 63.0k | Python + Rust core | MIT-ish (view) | 2026-11 ✅ | 100+ (incl. all 5 + `cloudflare`) | ✅ | ✅ auto-router, failover, circuit-breaker-style | ✅ budgets, RPM/TPM | ✅ virtual keys | ❌ server (port 4000) | ✅ OSS + paid |
| 2 | [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | 51.7k | Go | **AGPL-3.0** | 2026-11 ✅ | OpenAI/Claude/Gemini-compat | ✅ | ✅ channel failover | ✅ quota/token mgmt | ✅ | ❌ Go binary + DB | ✅ OSS (AGPL⚠) |
| 3 | [songquanpeng/one-api](https://github.com/songquanpeng/one-api) | 37.4k | Go | MIT | 2025-02 ⚠️stale | many | ✅ | ✅ load balance | ✅ token mgmt | ✅ | ❌ Go + DB | ✅ OSS |
| 4 | [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | 13.4k | **TypeScript** | **MIT** | 2026-05 (2.0 in dev) | 1600+ (**all 5 target**) | ✅ | ✅ retry+fallback+weighted LB | ⚠️ in hosted/enterprise | ✅ BYOK + virtual keys | ✅ **native** | ✅ OSS + paid |
| 5 | [tensorzero/tensorzero](https://github.com/tensorzero/tensorzero) | 11.7k | Rust | Apache-2.0 | 2026-06 | all majors | ✅ | ✅ routing/retry/fallback/LB | via observability | ✅ | ❌ Rust + ClickHouse | ✅ OSS |
| 6 | [maximhq/bifrost](https://github.com/maximhq/bifrost) | 9.5k | Go | Apache-2.0 | 2026-11 ✅ | 23+ (incl. Groq, Mistral) | ✅ | ✅ failover/LB | ✅ budgets/virtual keys | ✅ | ❌ Go binary (<200µs!) | ✅ OSS + paid |
| 7 | [mnfst/llm-gateway](https://github.com/mnfst/llm-gateway) | 7.6k | TypeScript | MIT | 2026-11 ✅ | 35+ providers | ✅ | ✅ self-heal fallback | ✅ cost tracking | ✅ | ❌ Docker+PG+Redis+S3 | ✅ OSS + $19 cloud |
| 8 | [MoyuFamily/ai-relay](https://github.com/MoyuFamily/ai-relay) | 132 | **TypeScript** | MIT | 2026-10 ✅ | OpenAI/Claude/DeepSeek… | ✅ | ✅ + **circuit breaking** | ✅ usage sampling | ✅ key rotation | ✅ **D1+KV** | ✅ OSS |

**Provider coverage check for the 5 target providers (★ = confirmed in source):**

| Tool | Groq | Gemini | Mistral | OpenRouter | CF Workers AI |
|------|:----:|:------:|:-------:|:----------:|:-------------:|
| **Portkey** | ★ | ★ | ★ | ★ | ★ |
| LiteLLM | ★ | ★ | ★ | ★ | ★ (`cloudflare`) |
| new-api / one-api | ★ | ★ | ⚠️ | ⚠️ | ⚠️ |
| Bifrost | ★ | ⚠️ | ★ | ⚠️ | ⚠️ |
| ai-relay | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |

---

## Deep Dive — Top 3

### 🥇 Portkey AI Gateway — *the only one that runs IN your Worker*

- **Repo:** `Portkey-AI/gateway` · 13.4k★ · MIT · TypeScript
- **Stack:** Built on **Hono** (edge-native), ships a real `wrangler.toml` (`main = "src/index.ts"`, `nodejs_compat` flag). `npm run dev` = `wrangler dev`; `npm run deploy` = `wrangler deploy --minify`. Runtime-detected: Redis cache only loads when `runtime === 'node'` + `REDIS_CONNECTION_STRING` set → on Workers it falls back to in-memory cache. ✅ genuinely edge-safe.
- **Features verified from README + source:**
  - **Retry** (up to 5, exponential backoff), **fallback** chains, **weighted load balancing**, **conditional routing**, **request timeouts**
  - **Guardrails** (40+ prebuilt, BYO guardrails)
  - **BYOK** + **virtual keys** + RBAC
  - **Caching** (simple + semantic*), usage analytics
  - **Multimodal**, **realtime/WebSocket** APIs, MCP gateway
  - 122 kB footprint, <1 ms overhead, 10B tokens/day claimed
- **Provider config** is a JSON `config` attached per-request — supports `retry`, `fallback`, `load_balance` (weights), `on_status_codes`, `conditional routing` (route by request metadata → enables sticky sessions).
- **Gaps vs your spec:**
  - No literal "circuit breaker" primitive — but retry+fallback+on_status_codes gives equivalent behavior. True stateful circuit-breaking needs Cloudflare **Durable Objects** for cross-request state.
  - Per-key **rate-limit tracking** in OSS is light (heavier in hosted/enterprise). Layer with Cloudflare's rate-limiting/KV counters.
  - "Sticky sessions" not named — achievable via conditional routing on a session header.
- **License risk:** None — MIT, fully embeddable in a closed-source product.

**Integration notes for micky-assistant (itty-router Worker):**
1. `npm i @portkey-ai/gateway` — or vendor the Hono app and mount under your existing itty-router `/v1/*`.
2. Portkey is itself a Hono app; simplest path is to **migrate the Worker from itty-router → Hono** (both edge-native, trivial) and mount Portkey's app, OR run Portkey as a **separate Worker** and `fetch()` to it from the current Worker.
3. Store provider keys as `wrangler secret put GROQ_API_KEY` etc.; pass into the Portkey `config` per-request (BYOK from the dashboard `micky_` keys map to virtual keys).
4. Provider coverage confirmed in `src/providers/index.ts`: `groq`, `gemini`, `mistral-ai`, `openrouter`, `workers-ai` all present. ✅
5. Watch the **2.0 branch** (pre-release, enterprise features merging to OSS) — pin to `1.15.x` for stability, track 2.0 for GA.

---

### 🥈 Cloudflare AI Gateway (managed) — *native rate-limit tracking + caching layer*

- **URL:** `developers.cloudflare.com/ai-gateway/` — Cloudflare's own product. **Not open-source**, but native to the platform and free tier.
- **Features:** request caching, **rate limiting**, **fallback** to a backup URL, real-time **analytics** (request volume, latency, cost, tokens), log persistence to R2/Workers AI.
- **How it fits:** Sits *in front of* provider calls. Endpoint pattern:
  `https://gateway.ai.cloudflare.com/v1/{ACCOUNT_TAG}/{GATEWAY}/{provider}/...`
  Supports per-provider sub-paths (`openai`, `anthropic`, `google-ai-studio`, `mistral`, `huggingface`, `aws-bedrock`…).
- **Gaps:** It's a thin proxy/observability shim, **not a router** — no cross-provider fallback logic, no request-body normalization, no virtual keys. Pair it **with** Portkey (Portkey does routing; CF AI Gateway does rate-limit tracking + analytics) for best-of-both.

**Integration notes:** Wrap each provider base URL with its CF AI Gateway URL. The existing `pokon548/ai-gateway-openai-wrapper` (146★) is a tiny reference Worker that demonstrates the foolproof dummy-key pattern. Use this to get **rate-limit tracking + cost analytics for free** without extra infra.

---

### 🥉 LiteLLM — *heaviest feature set, but runs as an external sidecar*

- **Repo:** `BerriAI/litellm` · 63.0k★ · MIT-view license · Python (now with Rust core for speed)
- **Features:** **Auto Router** (`auto_router`), 100+ providers (all 5 targets incl. `cloudflare`), **budgets**, **RPM/TPM rate limits**, **virtual keys**, per-key/team rate limits, circuit-breaker-style retries/fallbacks, streaming, guardrails, full observability UI, OpenTelemetry.
- **Why not #1 for you:** Pure-Python proxy server (port 4000) — **cannot run inside a Cloudflare Worker**. You'd deploy it (Docker / Cloud Run / a CF Container) and have the Worker `fetch()` it. Adds a network hop + a service to operate.
- **When to choose:** If you outgrow Portkey's OSS feature set and need **centralized budgets, team keys, and a management UI** that multiple Workers/services share.

**Integration notes:** Deploy LiteLLM proxy (e.g., on Cloudflare Containers or Fly.io, near your Worker's region for low latency). Worker sends OpenAI-shaped requests to `https://litellm.internal/v1/chat/completions` with a virtual key; LiteLLM handles routing/fallback/rate-limits to the 5 providers. Keep CF AI Gateway in front of LiteLLM's egress for analytics.

---

## Honorable mentions (not in top 3)

- **maximhq/bifrost** — if raw latency matters and you can run a Go sidecar: <200µs overhead at 5k RPS, semantic caching, MCP gateway, Apache-2.0. Best "fastest sidecar" option.
- **tensorzero** — if you want LLMOps (gateway + evals + prompt optimization + A/B testing) in one Rust binary. Overkill for pure routing.
- **new-api** — most popular self-hostable gateway (51.7k★) but **AGPL-3.0** ⚠️ — viral license is a blocker if micky-assistant is/could be closed-source. Use one-api (MIT) or Portkey instead.
- **MoyuFamily/ai-relay** — the only *other* truly CF-Workers-native TS gateway (D1+KV storage). 132★, actively maintained (v2.13.0, Oct 2026). Explicitly advertises **circuit breaking + key rotation**. Consider if you want a minimal, single-file alternative to Portkey and don't need 1600+ providers.

---

## Requirements Coverage Matrix (Top 3)

| Requirement | Portkey (in-Worker) | CF AI Gateway | LiteLLM (sidecar) |
|-------------|:-------------------:|:-------------:|:-----------------:|
| Multi-provider routing (all 5) | ✅ | ⚠️ (per-provider path only) | ✅ |
| Rate-limit tracking | ⚠️ (OSS light) | ✅ | ✅ budgets/RPM/TPM |
| Failover | ✅ | ✅ backup URL | ✅ |
| Streaming normalization | ✅ | passthrough | ✅ |
| BYOK secret mgmt | ✅ virtual+BYOK | ❌ | ✅ virtual+BYOK |
| Sticky sessions | ✅ conditional routing | ❌ | ✅ `auto_router` |
| Circuit breakers | ⚠️ (retry+fallback equiv.) | ❌ | ✅ |
| Runs in CF Worker | ✅ native | ✅ native | ❌ sidecar |
| Extra infra to operate | none | none | Docker+PG+Redis |

**→ No single tool scores 100%. Recommended combo: Portkey (in-Worker routing) + CF AI Gateway (rate-limit/cost analytics). Add Durable Objects for true stateful circuit breakers / sticky-session pinning if needed.**

---

## Next Actions

1. **Prototype Portkey in a throwaway Worker** — clone `Portkey-AI/gateway`, `npm i && npm run deploy`, point a test request at each of the 5 providers to confirm Groq/Gemini/Mistral/OpenRouter/Workers-AI egress works from the edge.
2. **Decide embed vs sidecar** — embed (migrate itty-router→Hono) keeps everything in one Worker deploy; sidecar keeps the current Worker untouched.
3. **Layer CF AI Gateway** in front of each provider base URL for free rate-limit + cost tracking (covers Portkey's OSS gap).
4. **Map BYOK** — the dashboard `micky_…` keys become Portkey virtual keys; real provider secrets stay in `wrangler secret put`.
5. **Stateful needs** — if true circuit breakers / cross-request sticky sessions are required, plan a Durable Object (or Redis via Upstash REST) for shared state.
6. **Track Portkey 2.0** GA — it merges enterprise features (deeper rate limits, budget tracking) into OSS.
7. **License check** — Portkey (MIT) + CF AI Gateway (ToS) are safe for closed-source; avoid new-api (AGPL).

---

*Research conducted Nov 2026 via GitHub Search API + raw README/wrangler/source fetches. No code was modified in the micky-assistant repo.*
