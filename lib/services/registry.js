// lib/services/registry.js — the service catalog.
//
// To add a SaaS service:
//   1. Copy any folder here (image_to_video, text_to_image, …) to
//      lib/services/<your_name>/.
//   2. Edit its config.js (cost, provider, prompts, workflow knobs).
//   3. Register it here with one line.
//   4. Wire a route in handlers/message.js (see the existing routes).
// That's it — payments, the job state machine, polling, timeouts, refunds,
// the sweep, and the relay handoff all come from lib/ and need no changes.
import { config as imageToVideo } from 'lib/services/image_to_video/config';
import { config as textToImage } from 'lib/services/text_to_image/config';
import { config as photoRestyle } from 'lib/services/photo_restyle/config';

export const SERVICES = {
  image_to_video: imageToVideo,
  text_to_image: textToImage,
  photo_restyle: photoRestyle,
};

export function getServiceConfig(name) {
  return SERVICES[name] ?? null;
}
