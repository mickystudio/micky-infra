# Provider Quota Ledger (D1)

Strongly-consistent, atomic quota tracking for the 11 free-tier LLM providers
used by micky-assistant. Replaces the eventually-consistent KV-based rate-limit
counters.

**Location:** `worker/src/gateway/ledger/`
**Binding:** `DB` (Cloudflare D1, `database_id = 3ef44fc8-fdfd-4844-9708-2ee4f923ece9`)
**Task:** A2

---

## Files

| File | Role |
|------|------|
| `schema.sql` | Canonical SQL migration (4 tables + 5 indexes). Run via `wrangler d1 execute`. |
| `ledger.ts` | `QuotaLedger` class + `PROVIDER_LIMITS` (11 providers) + TypeScript types. |
| `init.ts` | `initLedger(db)` — idempotent runtime bootstrap: applies schema + seeds today's rows. |
| `README.md` | This file. |

---

## Why D1 over KV

Workers KV was the previous home of the rate-limit counters. It is the wrong
tool for a quota ledger:

| Property | Workers KV | Cloudflare D1 |
|----------|-----------|---------------|
| Consistency | **Eventually consistent** (≤60 s cross-region propagation) | **Strongly consistent** (single Durable Object per DB, single writer) |
| Conditional / CAS writes | ❌ None — last-write-wins | ✅ `UPDATE … WHERE remaining > 0 RETURNING` is atomic |
| Per-key write rate | 1 write/sec/key (429 otherwise) | Bounded only by query duration (~1 ms → ~1k QPS) |
| Atomic read-decrement-write | ❌ Impossible — must read, then write (race) | ✅ Single statement |

The KV race in one sentence: two concurrent requests both `get()` the counter,
both see `remaining = 1`, both proceed, both `put(0)` → quota oversold by 1. At
scale this compounds. D1 has a single writer per database, so the conditional
`UPDATE` either decrements and returns, or matches zero rows — no
read-then-write race exists.

KV is still fine as a **short-TTL read cache** in front of the ledger (e.g. cache
`remaining` for 5–15 s), but the ledger is the source of truth.

---

## The atomic decrement pattern

The core of the ledger is a single SQL statement that checks the guard and
decrements in one atomic step, returning the new remaining:

```sql
UPDATE provider_quotas
   SET remaining_rpd = CASE WHEN remaining_rpd IS NULL THEN NULL
                             ELSE remaining_rpd - 1 END,
       remaining_tpd = CASE WHEN remaining_tpd IS NULL THEN NULL
                            ELSE remaining_tpd - ? END,
       last_request_at = ?,
       rpm_used = rpm_used + 1,
       tpm_used = tpm_used + ?
 WHERE provider = ?
   AND model = ?
   AND date_key = ?
   AND (remaining_rpd IS NULL OR remaining_rpd > 0)   -- hard gate + unlimited
   AND is_healthy = 1                                  -- circuit closed
   AND circuit_open_until < ?                          -- circuit not tripped
 RETURNING remaining_rpd, remaining_tpd;
```

Why this is correct under D1:

- **Single writer.** Each D1 database is backed by one Durable Object; queries
  execute one-at-a-time. Two concurrent `UPDATE`s against the same row are
  serialized; the second sees the first's effect.
- **Conditional.** The `WHERE remaining_rpd > 0` (or `IS NULL`) means the
  decrement is a no-op when the row is exhausted — it matches zero rows and
  returns nothing. The caller (`QuotaLedger.decrementQuota`) sees `ok: false`.
- **Returning.** `RETURNING` (SQLite ≥ 3.35, D1 ships ≥ 3.43) hands back the
  post-decrement value, so the caller knows the authoritative remaining count
  without a second read.

`NULL` semantics: `remaining_rpd = NULL` means **unlimited** (provider has no
documented daily cap). The `CASE` expression preserves NULL instead of
producing `NULL - 1 = NULL` (which is fine but explicit is clearer). The guard
`(remaining_rpd IS NULL OR remaining_rpd > 0)` lets unlimited providers through.

---

## Tables

| Table | Purpose |
|-------|---------|
| `provider_quotas` | Per-provider per-day ledger row. PK `(provider, model, date_key)`. |
| `conversation_provider_sticky` | Conversation → provider mapping (sticky sessions). |
| `provider_feedback` | 👍/👎 ratings per provider/message. |
| `provider_calls` | Append-only audit log of every provider call (powers stats + RPM). |

`provider_quotas` columns of note:
- `remaining_rpd` / `remaining_tpd` — NULL = unlimited
- `is_healthy` — 0 = circuit open (provider disabled)
- `circuit_open_until` — epoch ms; the circuit auto-re-closes after this time
- `consecutive_failures` — bumped by `record429()`; gateway opens circuit
  when this exceeds a threshold
- `last_429_at` — informational; recent 429 ⇒ likely still rate-limited

---

## The 11 providers and their free-tier limits

`PROVIDER_LIMITS` in `ledger.ts` is the canonical source. Numbers reflect
public free-tier docs as of late 2025 / early 2026 — **re-verify before
production tuning**.

| Provider | RPD | TPD | Notes |
|----------|-----|-----|-------|
| `groq1` | 14,400 | 1,000,000 | Groq primary key (Llama) |
| `groq2` | 14,400 | 1,000,000 | Groq backup key |
| `gemini` | 1,500 | 1,000,000 | Google Gemini Flash |
| `cerebras` | 1,500 | 500,000 | Cerebras inference |
| `sambanova` | 1,200 | 500,000 | SambaNova Cloud |
| `mistral` | 500 | 500,000 | Mistral La Plateforme |
| `openrouter` | 1,000 | 1,000,000 | OpenRouter free models |
| `workers-ai` | 10,000 | 5,000,000 | Cloudflare Workers AI (Neurons) |
| `together` | 1,000 | 500,000 | Together AI |
| `fireworks` | 1,000 | 500,000 | Fireworks AI |
| `deepinfra` | 1,000 | 500,000 | DeepInfra |

When a dedicated `gateway/providers.ts` config is introduced, `PROVIDER_LIMITS`
should import from it instead of being defined inline.

---

## Deploying the migration

### Option A — one-time migration via wrangler (recommended for first deploy)

From the `worker/` directory:

```bash
# Apply the schema to the remote D1 database
npx wrangler d1 execute micky-db --remote --file=src/gateway/ledger/schema.sql

# (optional) verify tables exist
npx wrangler d1 execute micky-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'provider%';"
```

### Option B — runtime bootstrap (idempotent, safe on every cold start)

Call `initLedger(env.DB)` once at the top of the Worker's `fetch` handler (or
in a module-level singleton). It runs `CREATE IF NOT EXISTS` + seeds today's
rows. Because every statement is idempotent, calling it on every request is
safe (though caching the ledger instance is cheaper):

```ts
import { initLedger } from './gateway/ledger/init';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ledger = await initLedger(env.DB); // idempotent
    // …use ledger.decrementQuota(…) etc.
  },
};
```

Both options are safe to combine: run the migration once for the first deploy,
then rely on `initLedger` for schema drift protection + daily seeding.

---

## Daily reset via cron

Quota rows are scoped by `date_key` (UTC `YYYY-MM-DD`). At UTC midnight the
previous day's row becomes stale and a new row with full limits must be seeded.
Add a daily cron trigger to `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *", "0 0 * * *"]   # existing 5-min poll + daily midnight UTC
```

Then in the `scheduled()` handler:

```ts
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const ledger = new QuotaLedger(env.DB);
    if (event.cron === '0 0 * * *') {
      await ledger.resetDailyQuotas(); // seeds today's rows for all 11 providers
    } else {
      await handleScheduled(env);     // existing 5-min Kaggle poll
    }
  },
};
```

`resetDailyQuotas()` is idempotent (`ON CONFLICT DO NOTHING`), so a cron that
fires slightly early or a manual re-run won't double-count. Old days' rows are
retained for analytics (success rate, token totals) and pruned by a separate
cleanup job (not in this migration).

---

## Usage cheat-sheet

```ts
import { QuotaLedger } from './gateway/ledger/ledger';
// or: import { initLedger } from './gateway/ledger/init';

const ledger = new QuotaLedger(env.DB);

// Atomic decrement (call after the LLM responds, with actual token count)
const res = await ledger.decrementQuota('groq1', '*', 540);
if (!res.ok) {
  // quota exhausted / circuit open → failover to next provider
}
// res.remaining === -1  → unlimited provider
// res.remaining === 0   → exhausted today (shouldn't happen if ok=true)

// Pre-flight check
const q = await ledger.getQuota('gemini', '*');
if (q && q.remaining_rpd !== null && q.remaining_rpd < 50) {
  // low, consider switching provider
}

// Sticky session (once a conversation is on a provider, prefer to stay)
const sticky = await ledger.getStickyProvider(chatId);
const provider = sticky ?? await pickProvider(ledger);
await ledger.setStickyProvider(chatId, provider, 'gemini-2.0-flash');

// Circuit breaker on 429
await ledger.record429('groq1');
await ledger.setProviderHealthy('groq1', false, Date.now() + 60_000); // open 60s
const healthy = await ledger.getHealthyProviders(); // ['gemini', 'cerebras', …]

// Audit + feedback
await ledger.recordCall({ provider: 'gemini', status: 'success',
  input_tokens: 1200, output_tokens: 540, latency_ms: 870 });
await ledger.recordFeedback('gemini', 1, msgId, 'code_request');

// Monitoring dashboard
const stats = await ledger.getProviderStats('groq1', 24);
// stats.successful, stats.avg_latency_ms, stats.rate_limited, …
```

---

## Constraints honoured

- ✅ All TypeScript, edge-compatible (no Node-only APIs).
- ✅ D1 / SQLite syntax (RETURNING, ON CONFLICT, composite PK).
- ✅ All dates in UTC (`new Date().toISOString()`).
- ✅ No `any` types — full typing on every method.
- ✅ Every file < 400 lines (`ledger.ts` ≈ 370, `init.ts` ≈ 110, `schema.sql` ≈ 95).
- ✅ Idempotent wherever possible (CREATE IF NOT EXISTS, ON CONFLICT DO NOTHING).
