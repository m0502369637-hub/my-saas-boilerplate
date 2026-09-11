# lib/ — shared modules (deployed, nestable)

Everything here runs inside Telegram Serverless's V8 isolate. Import modules by
bare name only — `import { pollJob } from 'lib/jobs'` — never with relative
paths or `.js` extensions.

| Module | What it owns |
| --- | --- |
| `lib/secrets.js` | Provider credentials. The platform has no env/secrets store — this is it. |
| `lib/jobs.js` | The job state machine (`queued → submitted → processing → complete\|failed\|timed_out`). All `jobs.status` writes go through here. |
| `lib/sweep.js` | The cron replacement: self-throttled piggyback sweep (timeouts + provider polls). |
| `lib/stars.js` | Telegram Stars invoices (XTR) + the internal wallet + payments rows. |
| `lib/fal_ai.js` | Fal AI queue client: submit / status / result / cancel / CDN upload. Never blocks. |
| `lib/comfyui.js` | ComfyUI client: upload / prompt / history / view / interrupt. Never blocks. |
| `lib/http.js` | fetch + retry-once helper (no timers — they're undocumented in the isolate). |
| `lib/telegram.js` | Bot API hardening: `safe()` for benign 400s, chunked replies, notify. |
| `lib/idempotency.js` | update_id claims — a monetised bot must not double-charge on redelivery. |
| `lib/auth.js` | User upsert (`/start`, every message) — the users row exists before any money moves. |
| `lib/app_state.js` | Tiny key/value store for bot-level state (sweep throttling, one-time setup). |
| `lib/db_util.js` | Write-result guards. |
| `lib/services/` | **The SaaS layer.** One folder per business module. See `lib/services/README.md` and the root `services/README.md` for the drop-in recipe. |
