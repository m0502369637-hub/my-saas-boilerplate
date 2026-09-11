# AGENTS.md

Orientation and **hard constraints** for AI coding agents (and humans)
working in this repository. Auto-loaded by Claude Code, Cursor, and similar
tools. The platform reference is
https://core.telegram.org/bots/serverless — when in doubt, it wins over any
assumption in this file.

## What this project is

A monetised SaaS bot boilerplate on **Telegram Serverless**: JavaScript
modules (`schema.js`, `lib/**`, `handlers/*.js`) deployed with `npx tgcloud
push` and run by Telegram in short-lived V8 isolates. There is no server, no
`node_modules` at runtime, no filesystem, no Node builtins. The worked
service: photo → AI video (Fal AI or ComfyUI), 100 Telegram Stars per
generation, with a fully async, refund-safe job queue.

## Layout — what is deployed

| Path | Deployed? | Role |
| --- | --- | --- |
| `schema.js` | ✅ | All database tables, as named exports. |
| `lib/**` | ✅ (nestable) | Shared modules. **All business modules live in `lib/services/<name>/`.** |
| `handlers/*.js` | ✅ (flat only) | One file per Telegram update type. Names are a closed set (`message`, `callback_query`, `pre_checkout_query`, … — run `npx tgcloud add handlers` to list them). |
| everything else | ❌ | Markdown, `.env.example`, `relay/`, `services/` (the recipe), `package.json` — local only. |

## Rules that bite — violations fail at deploy or at runtime

1. **Import by bare module name only.** `'sdk'`, `'sdk/db'`, `'schema'`,
   `'lib/…'` (path without `.js`). Relative paths, extensions, and npm
   packages do not compile. No `require()`.
2. **No foreign keys.** `.references()` / `foreignKey()` throw at
   declaration. Model relations with plain columns + indexes; enforce
   integrity in code.
3. **No environment access.** No `process.env`, no `.env`, no secrets store.
   Provider credentials live in `lib/secrets.js` (deployed) or behind a
   proxy the user hosts. Never invent a `tgcloud secrets` command.
4. **No timers, no filesystem, no `Buffer`.** `setTimeout`/`setInterval` are
   undocumented in the isolate — don't rely on them. Use `Uint8Array`,
   `TextEncoder`, `TextDecoder`. Outbound HTTP goes through `sdk`'s `fetch`
   (wrapped by `lib/http.js`).
5. **Every `db` call is async — always `await`.** Raw rows are unconverted
   (booleans 0/1, JSON strings, timestamps numeric); the table-bound builder
   converts.
6. **Handlers stay thin and fast.** Bound every handler's work (the sweep's
   budget is ~20 s; keep handlers well under 25 s of awaits). Answer
   `callback_query` first; tolerate benign 400s via `lib/telegram.js#safe`.
7. **Deduplicate money-moving handlers on `update_id`** — delivery is
   at-least-once. Wrap with `withUpdateClaim` from `lib/idempotency.js`.

## Do not block inside handlers waiting for AI jobs — ever

A generation takes 30 s → 10+ min; a handler invocation is short-lived.
The only legal pattern, already built into this repo:

1. Handler validates + debits + submits + replies with a status keyboard —
   then **returns**.
2. Completion arrives through one of: the 🔄 Check Status button
   (`handlers/callback_query.js` → `lib/jobs.js#pollJob`), the piggyback
   sweep (`lib/sweep.js`, since the platform has **no cron**), or the
   optional user-hosted relay (`relay/` → nudge → user taps 🔄; the platform
   has **no inbound HTTP**, so a `handlers/webhook.js` cannot exist).

When writing a new SaaS module: never `await` a provider result inside a
handler. Submit and return.

## The job state machine is owned by `lib/jobs.js` — exclusively

Statuses: `queued → submitted → processing → complete | failed | timed_out`.

- **Do not** write `jobs.status` anywhere outside `lib/jobs.js`.
- **Do** route every transition through `createJob`, `submitToProvider`,
  `pollJob`, `completeJob`, `failJob`, `timeoutJob`, `cancelJob`, `refund`.
- **Do** refund Stars on every `failed` / `timed_out` / cancelled path
  (handled inside `lib/jobs.js` — do not reimplement it).
- **Do** keep terminal transitions as conditional UPDATEs on the current
  status (the existing guards prevent double-refund/double-delivery; do not
  weaken them).
- **Do** append a `job_events` row for every transition (`addEvent`).

## Adding a new SaaS service

1. Copy `lib/services/image_to_video/` → `lib/services/<name>/`.
2. Edit its `config.js` (`name`, `cost`, `provider`, `maxJobAgeMs`,
   `pollAfterMs`, prompts/workflow).
3. Rewrite `index.js`'s dispatch (input handling + provider submit) — it
   must never await generation output.
4. Register in `lib/services/registry.js`.
5. Route in `handlers/message.js`.
6. `npx tgcloud push` — no schema change needed (jobs/payments are generic).

Full recipe: `services/README.md`.

## Deploy & migrate — two separate steps

```
npx tgcloud status      # offline diff
npx tgcloud push        # deploy code (never touches the database)
npx tgcloud migrate     # apply schema.js changes (safe = additive, reviewed)
npx tgcloud webhook     # confirm allowed_updates matches handlers/
npx tgcloud run handlers/message '<json5 payload>' --ctx '{ update: { update_id: 1 } }'
```

- `run` executes **on the platform with the real database and Bot API** —
  use test chat ids, never destructive payloads.
- Never use `push --force`, `migrate --yes`, or `webhook sync
  --drop-pending` as routine fixes; each discards something.
- Deploying never migrates; deleting a declaration never drops (use
  `.deprecated('reason')`).

## Money rules

- Balance mutations are conditional SQL updates — keep them atomic
  (`lib/stars.js`). Never read-modify-write a balance across awaits.
- A generation debits at job start and refunds on failure/timeout/cancel;
  every movement writes a `payments` row (`kind: 'charge' | 'refund'`).
- Stars invoices: currency `XTR`, no `provider_token`; `pre_checkout_query`
  must be answered (see `handlers/pre_checkout_query.js`).

## Allowed imports

`'sdk'`, `'sdk/db'` (also `'sdk/api'`, `'sdk/fetch'`), `'schema'`,
`'lib/*'`, `'handlers/*'` (for types only — handlers are entry points).
Nothing else exists at runtime.
