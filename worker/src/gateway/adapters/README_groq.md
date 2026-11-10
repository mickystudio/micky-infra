# Groq Adapter

`worker/src/gateway/adapters/groq.ts`

Groq exposes an **OpenAI-compatible** API at `https://api.groq.com/openai/v1`
(chat completions, streaming SSE, tool calling, `/models`). Because the wire
format is already OpenAI-shaped, this adapter is mostly an identity transform —
the interesting work is the **two-account fan-out** that doubles Groq's free
daily quota.

---

## Why two accounts?

Groq's free tier (no credit card) enforces per-account daily limits:

| Model                       | RPD (requests/day) | TPM (tokens/min) |
|-----------------------------|--------------------|------------------|
| `qwen3-32b`                 | 1 000              | 6 000            |
| `llama-3.1-8b-instant`      | 14 400             | —                |
| `llama-3.3-70b-versatile`   | 1 000              | —                |
| `openai/gpt-oss-120b`       | 1 000              | —                |
| `allam-2-7b`                | 7 000              | —                |

Each Groq account is a separate signup (different email) with its own API key
and its own quota bucket. By registering **two** accounts (`groq1`, `groq2`),
the gateway effectively gets:

> **groq1 + groq2 = 2× the daily limits** — e.g. `llama-3.3-70b-versatile`
> goes from 1 000 → 2 000 RPD, `llama-3.1-8b-instant` from 14 400 → 28 800
> RPD, etc. TPM ceilings also double because they are enforced per key.

The adapter itself does **no** scheduling — it is account-aware but
routing-agnostic. The gateway registry picks which account a given request
lands on (see *Sticky sessions* below).

---

## Wiring

| Env var       | Required | Purpose                                                       |
|---------------|----------|---------------------------------------------------------------|
| `GROQ_KEY_1`  | yes      | Bearer token for account 1. Set as a Workers secret.          |
| `GROQ_KEY_2`  | yes      | Bearer token for account 2. Set as a Workers secret.          |

```bash
# Register both secrets (one-time, per environment)
wrangler secret put GROQ_KEY_1   # paste account-1 key
wrangler secret put GROQ_KEY_2   # paste account-2 key
```

The worker `Env` interface (see `worker/src/index.ts`) must be extended with
these two fields so the adapter can read them:

```ts
export interface Env {
  // …existing bindings…
  GROQ_KEY_1: string;
  GROQ_KEY_2: string;
}
```

Two pre-wired instances are exported from the adapter module — import these
from the registry instead of constructing your own:

```ts
import { groq1Adapter, groq2Adapter, GroqAdapter } from '@/gateway/adapters/groq';

// groq1Adapter === new GroqAdapter(1)   → reads GROQ_KEY_1, providerId 'groq1'
// groq2Adapter === new GroqAdapter(2)   → reads GROQ_KEY_2, providerId 'groq2'
```

---

## How to add a third account (groq3)

The two-account design is **not** hardcoded — adding a third account is a
three-step change, all outside this file:

1. **Add a new secret.**
   ```bash
   wrangler secret put GROQ_KEY_3   # paste account-3 key
   ```
   and extend the worker `Env` with `GROQ_KEY_3: string;`.

2. **Teach `GroqAdapter` about the new account slot.** The constructor takes
   `accountId: 1 | 2`; widen it to `1 | 2 | 3` and extend the
   `getApiKey` / `getProviderId` branches:

   ```ts
   constructor(accountId: 1 | 2 | 3) { this.accountId = accountId; }

   private getApiKey(env: Env): string {
     const key =
       this.accountId === 1 ? env.GROQ_KEY_1 :
       this.accountId === 2 ? env.GROQ_KEY_2 :
                              env.GROQ_KEY_3;
     /* …existing guard… */
   }

   getProviderId(): ProviderId {
     return this.accountId === 1 ? 'groq1'
          : this.accountId === 2 ? 'groq2'
                                 : 'groq3';
   }
   ```
   (`ProviderId` becomes `'groq1' | 'groq2' | 'groq3'`.)

3. **Register the instance** in the gateway registry (wherever
   `groq1Adapter` / `groq2Adapter` are imported) alongside the existing two,
   and add `export const groq3Adapter = new GroqAdapter(3);` to this file.

Daily quota then triples (groq1 + groq2 + groq3 = 3× limits). The same recipe
extends to N accounts.

---

## Sticky sessions per conversation

Sticky-session routing (every message in a conversation must hit the **same**
account, so the model's KV context / token cache stays warm and one account
isn't asked to serve a context it doesn't have) is owned by the **gateway
registry**, not this adapter.

Concretely, the registry:

1. Hashes the `conversation_id` (or the user id when there is no conversation)
   into a stable slot in `[0, N)` where `N` is the number of registered Groq
   accounts.
2. Looks up the slot → adapter instance (`groq1Adapter` / `groq2Adapter` /
   …) and forwards the request to it via `adapter.chat(req, env)` or
   `adapter.chatStream(req, env)`.
3. On a 429 from that account, the registry performs a one-shot fail-over to
   the next slot (least-recently-used) and re-pins the conversation to the new
   account for the remainder of the window — recording the re-pin in the
   `RATE_LIMITS` KV so subsequent messages follow the new pin.

Because the adapter is **stateless** (the only per-instance state is the
`accountId`), the registry is free to pool, re-pin and fail-over between
instances without coordinating with the adapter.

---

## Adapter surface

`GroqAdapter` implements the shared `ProviderAdapter` contract from
`./types.ts` (the pure-shaping methods: `formatRequest`, `parseResponse`,
`parseStreamChunk`, `extractRateLimitInfo`, `getHeaders`, `getBaseUrl`,
`getChatCompletionsPath`, `getSupportedModels`, `provider`) **and** ships its
own self-contained I/O so the gateway can call it directly:

| Method                                        | Purpose                                                            |
|-----------------------------------------------|--------------------------------------------------------------------|
| `getAccountId(): 1 \| 2`                      | Which account slot this instance drives.                           |
| `getProviderId(): ProviderId`                | Account-specific id (`'groq1'` / `'groq2'`).                       |
| `static PROVIDER_ID`                         | Canonical family id (`'groq1'`) for registry lookups.              |
| `chat(req, env)`                              | Non-streaming; returns `{ response, raw }` so the caller can read   |
|                                               | `x-ratelimit-*` headers off `raw.headers`.                         |
| `chatStream(req, env)`                        | Streaming; returns a pull-based `ReadableStream<Uint8Array>` that   |
|                                               | passes Groq's OpenAI-shaped SSE through verbatim (zero re-parse).  |
| `listModels(env)`                             | `GET /models`.                                                     |
| `healthCheck(env)`                            | `true` iff `GET /models` returns a non-empty list.                 |
| `extractRateLimitInfo(headers)`               | Harvests `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` + |
|                                               | `retry-after` into a `QuotaState` (= shared `RateLimitInfo`).      |

### Backpressure

`chatStream` wraps the upstream body in a `ReadableStream` with
`highWaterMark: 0` — the upstream is read **exactly once per consumer
`read()`**. When the downstream client pauses, no bytes are pulled from Groq,
so the platform's TCP window backpressures the whole chain and Groq stops
generating (saving tokens / quota). `cancel(reason)` propagates downstream
cancellation back to the upstream reader so Groq stops generating immediately.

### Error handling

All failures throw `GroqError` carrying `status` + `upstreamBody` + `retryable`
+ `providerId`, so the gateway can:

- **429** → retryable, circuit-break this account for the `retry-after` window,
  fail-over to the sibling account.
- **5xx** → retryable, retry with backoff (possibly on the sibling account).
- **4xx (non-429)** → non-retryable, surface verbatim to the caller.
- **network failure** → `status: 0`, retryable.
- **missing key** → `status: 401`, non-retryable (config error).

The original upstream message and status are always preserved on the error.

---

## Testing

```bash
cd worker
bunx vitest run src/gateway/adapters/groq.test.ts
```

45 unit tests (no live network) cover: identity/construction, `formatRequest`
(strips `provider_options`), `parseResponse` validation, `parseStreamChunk`
edge cases (`[DONE]`, multi-event, partial JSON, comments, empty), rate-limit
header parsing (full + sparse + malformed), the full `chat` / `chatStream` /
`listModels` / `healthCheck` I/O paths with a `vi.fn()` mock on
`globalThis.fetch`, stream backpressure (pull count tracks consumer reads
exactly), cancellation propagation, and every error branch (429 / 5xx / 4xx /
network / missing key).
