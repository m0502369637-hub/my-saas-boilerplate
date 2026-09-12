# AGENTS.md

Orientation and **hard constraints** for AI coding agents (and humans) working
in this repository. Auto-loaded by Claude Code, Cursor, and similar tools.
The platform reference is https://docs.convex.dev — when in doubt, it wins
over any assumption in this file.

## What this project is

A monetised Telegram SaaS bot on **Convex**: classic Bot API webhook →
Convex HTTP action → Convex DB / scheduled functions / cron → provider
(fal.ai or ComfyUI) → media back to the user. One worked-example service
(`lib/services/image_to_video`), fully async refund-safe job queue. Pricing
lives only in the `SERVICE_COST` env var. This repo is the **base template**:
each real SaaS is cloned into its own repository (see `services/README.md`).

## Layout

| Path | Role |
| --- | --- |
| `convex/**` | Deployed Convex code (queries, mutations, actions, http, crons, schema). |
| `convex/lib/services/<name>/` | One service per folder: `config.ts` + `index.ts` only. Pure modules. **No workflow/template files** — the payload comes from the `PROVIDER_PAYLOAD` env var. |
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
   from `_generated/server`. (`process.env.CONVEX_SITE_URL` is the one
   system-var exception, used for the fal webhook URL.) The provider
   submission payload is `PROVIDER_PAYLOAD` (JSON env var) — **never commit
   model templates or workflow graphs to the repo.**
4. **No foreign keys, no SQL.** Relations are plain fields + indexes; integrity
   is enforced in code. Mutations are serializable transactions — a
   read-check-write inside one mutation is race-free. Never read-modify-write
   a balance across awaits (each mutation is atomic; actions must call
   mutations for every state change).
5. **The job state machine is owned by `jobs.ts` — exclusively.**
   Statuses: `queued → submitted → processing → complete | failed |
   timed_out | cancelled`. Do not write `jobs.status` anywhere else. Route
   every transition through `createJob`, `markSubmitted`, `markPolled`,
   `beginDelivery`, `completeJob`, `failJob`, `timeoutJob`, `cancelJob`.
   Every failed/timed_out/cancelled path refunds inside the same transaction
   that flips the status.
6. **Do not block inside update handling.** `updates.processUpdate` may
   await the submit (a few fast HTTP calls) but NEVER generation output.
   Completion arrives via the scheduler chain (`markSubmitted` schedules the
   first `pollJob` atomically), the `/fal/webhook` accelerator, the 🔄 button,
   or the cron sweep.
7. **Idempotency on `update_id`.** Webhook delivery is at-least-once; claim
   each update in `processed_updates` (done in `processUpdate`) before any
   side effect.
8. **Money rules.** Stars invoices: currency `XTR`, no `provider_token`,
   payload `buy_stars`; `pre_checkout_query` must be answered ok. Credit from
   Telegram's `total_amount`, never from a payload. Debit only inside
   `createJob` (atomic balance gate). Every wallet movement writes a
   `payments` row.
9. **Callback payloads** are `check:<jobId>` / `cancel:<jobId>` /
   `buy:<amount>` — keep them under 64 bytes.

## Adding a new SaaS service — in its OWN repository

The base repo ships exactly one worked example and must stay clean. A new
SaaS is a new repository:

1. `git clone` this repo into the new service's repo (keep `upstream` pointing
   here to pull plumbing updates later).
2. Copy `convex/lib/services/image_to_video/` → `convex/lib/services/<name>/`.
3. Edit `config.ts` (name, title, description, provider, `pollAfterMs`,
   `maxJobAgeMs`, trigger, injection knobs). The provider payload is NOT a
   file — supply it per deployment via `PROVIDER_PAYLOAD`. The price is NOT
   a file either — it is the `SERVICE_COST` env var (set per deployment).
4. Rewrite `index.ts`'s `buildProviderPayload` (pure — merge the payload with
   runtime photo/prompt; no network, no DB).
5. Register in `convex/lib/services/registry.ts` (drop the example entry).
6. Route the trigger in `convex/updates.ts`.
7. Deploy: `npx convex dev` (link project) → `npx convex env set …` →
   `npm run deploy` → `npm run webhook:set`.

Full recipe: `services/README.md`. Never add a second service folder to the
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
