# my-saas-boilerplate

A **clone-and-reuse skeleton for monetised Telegram SaaS bots on Convex**:
classic Bot API webhook, an internal Stars wallet with Telegram invoices and
automatic refunds, and a fully async, refund-safe job queue built on Convex
scheduled functions.

**The base repo ships NO services and NO providers.** It is pure plumbing
with two extension points — a service contract and a provider adapter
contract. Each real SaaS clones this repo into its own and adds one service +
one provider (see `services/README.md`).

## What's inside

- **`convex/http.ts`** — the `/telegram` webhook (secret-token verified) and `/healthz`.
- **`convex/updates.ts`** — the bot brain: `/start` `/balance` `/jobs` `/help`,
  photo (single + album) and prompt-command routing, Stars payments,
  check/cancel/buy callbacks, `update_id` idempotency.
- **`convex/jobs.ts`** — the job state machine (`queued → submitted →
  processing → complete | failed | timed_out | cancelled`). Mutations only;
  every terminal transition refunds in the same transaction.
- **`convex/jobs_actions.ts`** — submit/poll/cancel/deliver orchestration.
  It resolves providers through `lib/providers/registry.ts` and knows nothing
  about any specific provider.
- **`convex/lib/services/`** — the service contract + registry (empty here).
- **`convex/lib/providers/`** — the provider contract + registry (empty here).
- **`convex/crons.ts`** — minute-level sweep (timeouts + lost polls) and pruning.

## Architecture

```
Telegram ──webhook──▶ https://<deployment>.convex.site/telegram
                          │ secret-token check → updates.processUpdate
                          │   trigger (photo/prompt) → jobs.createJob (debit SERVICE_COST)
                          │                              → jobs_actions.submitJob
                          │   successful_payment → credit wallet
                          │   🔄 check / ❌ cancel → pollJob / cancelJob
                          ▼
        YOUR provider ◀──submit/poll── jobs_actions (via providers/registry)
                                  │ scheduler chain + cron sweep
                                  ▼
        result → beginDelivery → send media → completeJob (or fail + refund)
```

## Quickstart (empty bot)

Prereqs: Node ≥ 20, a Telegram bot from @BotFather (Serverless **off**), a
[Convex account](https://dashboard.convex.dev).

```bash
npm install
npx convex dev                        # login + create the Convex project
npx convex env set BOT_TOKEN '123456:ABC…'
npx convex env set WEBHOOK_SECRET "$(openssl rand -hex 16)"
npx convex env set SERVICE_COST '100' # Stars per generation — change anytime, no redeploy
npm run deploy                        # npx convex deploy
cp .env.example .env.local            # fill BOT_TOKEN + WEBHOOK_SECRET
WEBHOOK_URL=https://<deployment>.convex.site npm run webhook:set
```

Out of the box the bot answers `/start`, `/balance`, `/jobs`, `/help` and
says "no service configured" — it has no service yet. Add one per
`services/README.md`.

### Local development

```bash
npx convex dev          # terminal 1 — local backend
npm run dev:poll       # terminal 2 — long-poll updates into 127.0.0.1:3210
```

## Environment variables

Declared in `convex/convex.config.ts` (deploy-time validated).

| Name | Required | Purpose |
| --- | --- | --- |
| `BOT_TOKEN` | ✅ | Classic Bot API token |
| `WEBHOOK_SECRET` | ✅ | `setWebhook` secret_token; verified on every delivery |
| `SERVICE_COST` | ✅ | Price per generation in Stars (positive integer) — **the only place pricing lives**; `npx convex env set SERVICE_COST '120'`, no redeploy |

A SaaS repo adds its provider's secrets to its own `convex.config.ts`.

## Money

- Users buy Stars via a real Telegram invoice (`XTR`); the payment credits the
  internal wallet (`users.balance`) from Telegram's trusted `total_amount`.
- A generation **debits** the wallet and writes a `payments` row in the same
  transaction that creates the job; the charged price is stamped on the job.
- Every `failed` / `timed_out` / `cancelled` job **refunds** in the same
  transaction that flips the status. Convex serializes mutations, so double
  refunds and double delivery are structurally impossible.
- Each `update_id` is claimed exactly once before any money moves.

## Jobs

`queued → submitted → processing → complete | failed | timed_out | cancelled`,
owned exclusively by `convex/jobs.ts`. Triggers start `queued` jobs;
`submitJob` resolves photos + submits via the registered provider and —
atomically — schedules the first poll; `pollJob` re-schedules itself and
times out past `maxJobAgeMs`; completion flows through the exactly-once
`beginDelivery` lock; a cron sweep is the safety net.

## Adding a service

**Never add a service to this repo.** Clone it into a new repository, add your
service folder + provider adapter, register both, deploy — full recipe in
[`services/README.md`](services/README.md).

## Limits worth knowing

- Bot API media uploads cap at 50 MB per file — over-sized provider outputs
  fail delivery and refund automatically.
- HTTP action request/response bodies cap at 20 MB (updates are tiny).
- Callback payloads ≤ 64 bytes (`check:<convex-id>` fits).
