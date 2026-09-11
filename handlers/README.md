# handlers/ — update entry points (flat, one file per Telegram update type)

The platform invokes a handler's `export default` with the unwrapped update
payload — for `handlers/message` that's the `Message`, for
`handlers/callback_query` the `CallbackQuery` — plus a `ctx` whose
`ctx.update` is the raw `Update`. An update type is handled only if its file
exists and is non-empty, and the platform derives the bot's webhook
`allowed_updates` from the deployed handler set.

| File | Why it exists |
| --- | --- |
| `message.js` | Commands, photos (→ the service), and `successful_payment` (Stars invoices arrive as messages). |
| `callback_query.js` | `check:` / `cancel:` job buttons, `buy_100_stars` invoice button. |
| `pre_checkout_query.js` | Mandatory accept-step for XTR invoices — without it, no Stars payment can ever complete. |

## Where are webhook.js and cron.js?

Both names are **not** Telegram update types, so they cannot be handler
files — a handlers/ directory is a closed set (run `npx tgcloud add handlers`
to see the accepted names). Their jobs live elsewhere:

- Provider webhook receiver → `relay/relay.mjs`, an optional tiny Node app
  you host (the platform has no inbound HTTP endpoints).
- Scheduled sweep → `lib/sweep.js`, piggybacked on user activity with
  self-throttling and a hard budget.

Both are fully wired and documented in the README; the bot is production-
resilient with or without the relay.
