# New Provider Adapters — Agent A10

Five new OpenAI-compatible LLM provider adapters for the Micky Assistant
gateway, all on a shared `BaseOpenAICompatibleAdapter` base class.

| Provider | Adapter file | Default model | Free tier (no card) | OpenAI compat | Quirks |
|---|---|---|---|---|---|
| **SambaNova** | `sambanova.ts` | `DeepSeek-V3.1` | 20 RPM · 20 RPD · 200K TPD | `/v1` (full) | 429 w/o `Retry-After`; rate limits are **per-model**, not per-account |
| **Cohere** | `cohere.ts` | `command-a-plus-05-2026` | 1,000 calls/month · 20 RPM | `/compatibility/v1` (NOT `/v1`) | **Monthly** quota (not daily); tool-calling normalized server-side by the compatibility endpoint |
| **SiliconFlow** | `siliconflow.ts` | `deepseek-ai/DeepSeek-V3` | ~$2 signup credit + $0-priced models | `/v1` (full) | Model IDs include vendor prefix (`deepseek-ai/…`); response includes a USD `cost` field (captured into `provider_meta.cost`) |
| **Cerebras** | `cerebras.ts` | `qwen-3.8-27b` | 1M tokens/day · 50 RPM | `/v1` (full) | Ultra-fast inference (2k+ tok/s on LPU) — don't apply client-side token/sec throttles |
| **Novita AI** | `novita.ts` | `deepseek/deepseek-v4.1-flash` | Signup voucher + tiered RPM/TPM | `/openai` prefix (NOT `/v1`) | Some models live on alternate base URLs (override via `NOVITA_MODEL_BASE_OVERRIDES`) |

---

## Signup URLs (all email-only, no card)

| Provider | Signup URL | Env var to set |
|---|---|---|
| SambaNova | <https://cloud.sambanova.ai/apis> | `SAMBANOVA_KEY` |
| Cohere | <https://dashboard.cohere.com/api-keys> | `COHERE_KEY` |
| SiliconFlow | <https://cloud.siliconflow.cn/account/ak> | `SILICONFLOW_KEY` |
| Cerebras | <https://cloud.cerebras.ai/> | `CEREBRAS_KEY` |
| Novita AI | <https://novita.ai/getKey> | `NOVITA_KEY` |

Set each via `wrangler secret put <ENV_VAR_NAME>` (or `bun run secret:set
<ENV_VAR_NAME>` — the worker `package.json` aliases this). Placeholder
values work for local dev; swap in real keys before deploy.

---

## File layout

```
worker/src/gateway/adapters/
├── _types.ts                     ← ProviderAdapter contract (Agent A10)
├── _base.ts                      ← BaseOpenAICompatibleAdapter (shared logic)
├── sambanova.ts                  ← SambaNovaAdapter
├── cohere.ts                     ← CohereAdapter
├── siliconflow.ts                ← SiliconFlowAdapter
├── cerebras.ts                   ← CerebrasAdapter
├── novita.ts                     ← NovitaAdapter
├── README_new_providers.md       ← (this file)
└── __tests__/
    └── new_providers.test.ts     ← request formatting, response parsing, rate-limit extraction
```

### Why a separate `_types.ts`?

The repo already had two parallel `ProviderAdapter` interfaces:
`gateway/types.ts` (Task A6 — HTTP-shape-only with optional `chat?` /
`chatStream?` for binding adapters like Workers AI) and
`gateway/adapters/types.ts` (Task A8 — richer `getChatCompletionsPath` /
`getSupportedModels`). The Agent A10 brief describes a THIRD, self-contained
contract where every adapter owns its own `chat` / `chatStream` /
`listModels` / `healthCheck` I/O (no separate fetcher). To avoid overwriting
either existing file and breaking their downstream adapters, we keep the
new contract local to the five new adapters in `_types.ts`. The router can
import both styles; TypeScript treats them as three separate interfaces in
three separate modules.

---

## Common patterns (the shared base class)

`BaseOpenAICompatibleAdapter` centralizes ~250 lines of fetch-retry-stream-
parse boilerplate. Subclasses override only the **quirks** via protected
hook points:

| Hook | Default | Override when… |
|---|---|---|
| `PROVIDER_ID` (abstract) | — | Always — provider identity |
| `getChatEndpoint()` | `/chat/completions` | Provider puts chat elsewhere |
| `getModelsEndpoint()` | `/models` | Provider puts model list elsewhere |
| `mutateRequest(req)` | identity | Provider needs body tweaks (e.g. drop unsupported fields) |
| `mutateRawResponse(raw)` | identity | Provider mangles the response shape (e.g. SiliconFlow's `cost` field) |
| `rateLimitHeaderMap()` | `{}` | Provider uses non-standard `x-ratelimit-*` header names |
| `resolveBaseUrl(model)` | `this.baseUrl` | Some models live on alternate hosts (Novita) |

The base class provides:
- **Retry**: 1 initial + 2 retries with exponential backoff (250ms · 500ms · 1s · ±20% jitter) on 5xx and 429
- **Error classes**: `ProviderError` (with `status`, `retryable`, `upstreamBody`), `RateLimitError` (429 + rateLimit info), `NetworkError` (always retryable)
- **Rate-limit parsing**: standard `x-ratelimit-*` family + `retry-after` + `date`
- **SSE streaming**: line-buffered `data: <json>\n\n` parser → normalized `ChatStreamChunk`s
- **Health check**: `GET /models` with a 5s `AbortController` timeout
- **`listModels` fallback**: returns a static curated list if `/models` 5xx's

---

## How to add the 6th provider (template)

1. **Copy the template below** to `worker/src/gateway/adapters/<provider>.ts`.
2. **Pick a `ProviderId`** and add it to `isProviderId()` in `_types.ts`.
3. **Add the model list** + base URL constants.
4. **Override only the hooks you need** — most providers need zero overrides.
5. **Add a row to the comparison table** above.
6. **Add tests** in `__tests__/new_providers.test.ts`.

### Template

```ts
/**
 * Micky Assistant — <Provider Name> adapter (Agent A10+).
 * Brief one-paragraph description: what is it, what's the free tier, what's
 * the OpenAI-compat story.
 *
 * Quirks handled here:
 *   • <quirk 1>
 *   • <quirk 2>
 *
 * Env: `<PROVIDER>_KEY` (Bearer token). Resolved by the factory below.
 */
import { BaseOpenAICompatibleAdapter } from './_base';
import type { ModelInfo, ProviderId } from './_types';

export const PROVIDER_BASE_URL = 'https://api.example.com/v1';
export const PROVIDER_KEY_ENV = '<PROVIDER>_KEY';
export const PROVIDER_DEFAULT_MODEL = '<model-id>';

export const PROVIDER_MODELS: ModelInfo[] = [
  { id: '<model-id>', object: 'model', created: 0, owned_by: '<vendor>', label: '<label>', free_tier: true },
  // …
];

export class ProviderAdapter extends BaseOpenAICompatibleAdapter {
  readonly PROVIDER_ID: ProviderId = '<providerid>';  // add to ProviderId union first!

  constructor(apiKey: string) {
    super({
      apiKey,
      baseUrl: PROVIDER_BASE_URL,
      defaultModel: PROVIDER_DEFAULT_MODEL,
      staticModels: PROVIDER_MODELS,
    });
  }

  // Override hooks here ONLY if the provider has quirks. Examples:
  //
  // protected getChatEndpoint(): string { return '/openai/chat/completions'; }
  //
  // protected rateLimitHeaderMap() {
  //   return { 'x-monthly-remaining': 'requestsRemaining' };
  // }
  //
  // protected resolveBaseUrl(model: string): string {
  //   return MODEL_HOST_OVERRIDES[model] ?? this.baseUrl;
  // }
}

export function createProviderAdapter(env: Record<string, unknown>): ProviderAdapter {
  const key = env[PROVIDER_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `ProviderAdapter: ${PROVIDER_KEY_ENV} is not configured. ` +
        `Set it with: wrangler secret put ${PROVIDER_KEY_ENV}`,
    );
  }
  return new ProviderAdapter(key);
}
```

### Don't forget

- **No `any`** — use `unknown` + narrow with `as`/type guards.
- **Edge-only** — `fetch`, `Headers`, `ReadableStream`, `TextDecoder`,
  `AbortController`, `setTimeout` are all OK on Workers. No Node APIs.
- **Handle 429 / 5xx / network errors** — the base class already does;
  only override if the provider's error shape differs.
- **Extract rate limits** — the base class handles standard headers; only
  override `rateLimitHeaderMap()` for non-standard names.
- **< 300 lines** — the base class is the only file that exceeds this; the
  adapters themselves stay small by leaning on the base.

---

## Wiring the adapters into the router

The factory functions (`createSambaNovaAdapter`, etc.) take a `Record<string,
unknown>` (the worker env) so the router can build all five in a single loop:

```ts
import { createSambaNovaAdapter } from './sambanova';
import { createCohereAdapter }      from './cohere';
import { createSiliconFlowAdapter } from './siliconflow';
import { createCerebrasAdapter }    from './cerebras';
import { createNovitaAdapter }      from './novita';

const adapters = [
  createSambaNovaAdapter(env),
  createCohereAdapter(env),
  createSiliconFlowAdapter(env),
  createCerebrasAdapter(env),
  createNovitaAdapter(env),
];
```

If a provider's key is missing, its factory throws with a clear `wrangler
secret put <ENV_VAR>` hint, so misconfiguration surfaces at boot, not at
first request.
