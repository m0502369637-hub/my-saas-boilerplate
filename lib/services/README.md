# lib/services/ — the SaaS layer

**The full drop-in recipe lives at the repo root in [`services/README.md`](/services/README.md)**
(the folder you'll reach for when adding a business module). The short version:

1. Copy `lib/services/image_to_video/` → `lib/services/<your_name>/`.
2. Edit its `config.js` (name, cost, provider, prompts, workflow knobs).
3. Register it in `lib/services/registry.js`.
4. Wire a route in `handlers/message.js`.

Payments, the job state machine, polling, timeouts, refunds, the sweep, and
the relay handoff are all generic `lib/` glue — a new service touches none of
them. `index.js` is the only service file that knows about its own media
types; everything else is shared.

## Shipped services (the recipe applied three times)

| Service | Trigger | Provider | Cost | Output |
| --- | --- | --- | --- | --- |
| `image_to_video` | photo (no caption) | fal_ai or comfyui | 100 ⭐ | video |
| `photo_restyle` | photo captioned `/restyle` | comfyui | 75 ⭐ | image |
| `text_to_image` | `/imagine <prompt>` | fal_ai | 50 ⭐ | image |

Each one is also a worked example of a different shape: file upload vs.
pure-text input, video vs. image output, fal vs. ComfyUI provider.

*Why `lib/services/` and not a root `services/` folder?* The platform deploys
only `schema.js`, `lib/**`, and `handlers/*.js`, and resolves imports by bare
module name. `lib/` is the only directory allowed to nest, so this is the one
place a per-service folder system can legally live.
