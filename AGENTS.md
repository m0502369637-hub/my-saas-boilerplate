# AGENTS.md

Orientation and **hard constraints** for AI coding agents (and humans) working
in this repository. Auto-loaded by Claude Code, Cursor, and similar tools.
The platform reference is https://docs.convex.dev — when in doubt, it wins
over any assumption in this file.

## What this project is

A monetised Telegram SaaS bot skeleton on **Convex**: classic Bot API webhook
→ Convex HTTP action → Convex DB / scheduled functions / cron → provider →
media back to the user. The base repo ships **NO services and NO providers**
— it is pure plumbing with two extension points: the service contract
(`lib/services/`) and the provider adapter contract (`lib/providers/`). Each
real SaaS is a separate repository cloned from this one (see
`services/README.md`). Pricing lives only in the `SERVICE_COST` env var.

## Layout

| Path | Role |
| --- | --- |
| `convex/**` | Deployed Convex code (queries, mutations, actions, http, crons, schema). |
| `convex/lib/services/types.ts` + `registry.ts` | Service contract + EMPTY registry. A SaaS repo adds one service folder and registers it. |
| `convex/lib/providers/types.ts` + `registry.ts` | Provider adapter contract + EMPTY registry. A SaaS repo implements its provider(s) and registers them. |
| `convex/_generated/` | Generated types — **committed** (code won't typecheck without it). Regenerate with `npx convex codegen --system-udfs --init` after schema/env changes; `npx convex dev`/`deploy` regenerate too. |
| `scripts/*.ts` | Local-only tooling: `dev-poll.ts` (long polling in dev), `set-webhook.ts`. |
| everything else | Docs, `package.json`, `.env.example`. |

## Rules that bite

1. **Mutations and queries are deterministic.** No `fetch`, no external calls,
   no non-seeded randomness, `Date.now()` is frozen per execution (still fine
   for timestamps/guards). All external I/O lives in **actions**.
2. **Actions run in the default web-standards runtime** (fetch, Blob,
   FormData, TextEncoder, Uint8Array — all fine). If you ever need Node
   builtins (`Buffer`, `node:*`, npm Node-only libs), that file must start
   with `"use node"`, may contain **only actions**, and may only be imported
   by other actions.
3. **`env` only, never `process.env` for your own vars.** Env vars are
   declared in `convex/convex.config.ts` and read via the typed `env` import
   from `_generated/server`. The base declares `BOT_TOKEN`, `WEBHOOK_SECRET`,
   `SERVICE_COST`; a SaaS repo adds its provider's secrets to its own copy.
4. **No provider code in this repo.** The base must stay provider-free: no
   SDKs, no API keys, no provider-specific endpoints. Providers live in SaaS
   repos as adapters implementing `lib/providers/types.ts#Provider`.
5. **No foreign keys, no SQL.** Relations are plain fields + indexes; integrity
   is enforced in code. Mutations are serializable transactions — a
   read-check-write inside one mutation is race-free. Never read-modify-write
   a balance across awaits (each mutation is atomic; actions must call
   mutations for every state change).
6. **The job state machine is owned by `jobs.ts` — exclusively.**
   Statuses: `queued → submitted → processing → complete | failed |
   timed_out | cancelled`. Do not write `jobs.status` anywhere else. Route
   every transition through `createJob`, `markSubmitted`, `markPolled`,
   `beginDelivery`, `completeJob`, `failJob`, `timeoutJob`, `cancelJob`.
   Every failed/timed_out/cancelled path refunds inside the same transaction
   that flips the status.
7. **Do not block inside update handling.** `updates.processUpdate` may
   await the submit (a few fast HTTP calls) but NEVER generation output.
   Completion arrives via the scheduler chain (`markSubmitted` schedules the
   first `pollJob` atomically), the 🔄 button, or the cron sweep.
8. **Idempotency on `update_id`.** Webhook delivery is at-least-once; claim
   each update in `processed_updates` (done in `processUpdate`) before any
   side effect.
9. **Money rules.** Stars invoices: currency `XTR`, no `provider_token`,
   payload `buy_stars`; `pre_checkout_query` must be answered ok. Credit from
   Telegram's `total_amount`, never from a payload. Debit only inside
   `createJob` (atomic balance gate). The price is the `SERVICE_COST` env var,
   stamped onto each job so refunds match the charge. Every wallet movement
   writes a `payments` row.
10. **Callback payloads** are `check:<jobId>` / `cancel:<jobId>` /
    `buy:<amount>` — keep them under 64 bytes.

## Adding a new SaaS — in its OWN repository

This repo ships no services and must stay that way. A new SaaS is a new
repository:

1. `git clone` this repo into the new service's repo (keep `upstream` pointing
   here to pull plumbing updates later).
2. Add a service: `convex/lib/services/<name>/` (`config.ts` + `index.ts`,
   pure modules — no network, no DB, no price, no committed provider payloads).
3. Add a provider: implement `Provider` from `convex/lib/providers/types.ts`
   in e.g. `convex/lib/providers/my_provider.ts` and register it in
   `convex/lib/providers/registry.ts` (matching `config.provider`).
4. Register the service in `convex/lib/services/registry.ts`.
5. Add provider secrets to `convex/convex.config.ts` + `.env.example`.
6. Route the trigger in `convex/updates.ts` (photo triggers and prompt
   commands are handled generically via `photoService()`/`promptService()`).
7. Deploy: `npx convex dev` (link project) → `npx convex env set …` →
   `npm run deploy` → `npm run webhook:set`.

Full recipe: `services/README.md`. Never add a service or provider to the
base repo.

## Deploy & verify

```
npm run typecheck        # tsc on convex/ + scripts/
npx convex codegen --system-udfs --init   # regenerate committed types after schema/env edits
npx convex deploy        # deploy code + schema + cron
npx convex env set NAME value   # prod env vars (dev reads .env.local)
WEBHOOK_URL=… npm run webhook:set   # point Telegram at the deployed /telegram route
```

- `convex deploy` pushes schema + functions + cron in one go; check the
  dashboard Logs after deploy.
- `npm run webhook:set -- --delete` switches back to long-polling mode.
- In dev, `npx convex dev` serves HTTP actions at
  `http://127.0.0.1:3210`; `npm run dev:poll` forwards Telegram updates there.

## Allowed imports

`convex/*` (functions, values, server), `./_generated/*`, `./lib/*`,
`./schema` (types). Node-only imports only in `"use node"` action files.
Never import files across the runtime boundary (default ↔ node).
