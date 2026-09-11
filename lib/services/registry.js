// lib/services/registry.js — the service catalog.
//
// To add a SaaS service:
//   1. Copy lib/services/image_to_video/ to lib/services/<your_name>/.
//   2. Edit its config.js (cost, provider, prompts, workflow tweaks).
//   3. Register it here with one line.
//   4. Wire a route in handlers/message.js (see the image_to_video example).
// That's it — payments, the job state machine, polling, timeouts, refunds,
// and the sweep all come from lib/ and need no changes.
import { config as imageToVideo } from 'lib/services/image_to_video/config';

export const SERVICES = {
  image_to_video: imageToVideo,
};

export function getServiceConfig(name) {
  return SERVICES[name] ?? null;
}
