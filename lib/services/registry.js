// lib/services/registry.js — the service catalog.
//
// THIS REPO SHIPS ONE WORKED EXAMPLE (image_to_video). Each real SaaS
// service lives in its OWN repository, cloned from this boilerplate:
//   1. git clone <boilerplate> my-new-saas && cd my-new-saas
//   2. Copy lib/services/image_to_video/ → lib/services/<your_name>/.
//   3. Edit its config.js (cost, provider, prompts, workflow knobs).
//   4. Register it here with one line (replace or extend SERVICES).
//   5. Wire a route in handlers/message.js.
//   6. Push to the new service's repo — never accumulate services here.
//
// Payments, the job state machine, polling, timeouts, refunds, the sweep,
// and the relay handoff all come from lib/ and need no changes.
import { config as imageToVideo } from 'lib/services/image_to_video/config';

export const SERVICES = {
  image_to_video: imageToVideo,
};

export function getServiceConfig(name) {
  return SERVICES[name] ?? null;
}
