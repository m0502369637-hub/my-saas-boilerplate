# lib/services/ — the SaaS layer

**The full drop-in recipe lives at the repo root in [`services/README.md`](/services/README.md)**
(the folder you'll reach for when adding a business module). The short version:

1. **Clone this base repo into a new repository** for the new service —
   never accumulate services in the base.
2. Copy `lib/services/image_to_video/` → `lib/services/<your_name>/`.
3. Edit its `config.js` (name, cost, provider, prompts, workflow knobs).
4. Register it in `lib/services/registry.js` (drop the example if unused).
5. Wire a route in `handlers/message.js`.

Payments, the job state machine, polling, timeouts, refunds, the sweep, and
the relay handoff are all generic `lib/` glue — a new service touches none of
them. `index.js` is the only service file that knows about its own media
types; everything else is shared. The state machine auto-adapts to the
output kind (`video` or `image` — sendVideo/sendPhoto), and fal submits work
for any model via `submitRequest`.

## What ships here

| Folder | What it is |
| --- | --- |
| `image_to_video/` | The **worked example**: photo → video, 100 ⭐, fal_ai or comfyui. Copy me. |

*Why `lib/services/` and not a root `services/` folder?* The platform deploys
only `schema.js`, `lib/**`, and `handlers/*.js`, and resolves imports by bare
module name. `lib/` is the only directory allowed to nest, so this is the one
place a per-service folder system can legally live.
