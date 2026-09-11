// lib/services/text_to_image/fal_workflow.js — Fal model id + payload template.
//
// Kept as a JS module because the platform deploys ONLY .js files under lib/.
// The service merges this template + config.fal + the user's prompt at submit
// time. Full schema: https://fal.ai/models/fal-ai/flux-pro/v1.1-ultra
export default {
  model: 'fal-ai/flux-pro/v1.1-ultra',
  input: {
    prompt: 'A photorealistic cat astronaut floating in space, cinematic lighting',
    num_images: 1,
    aspect_ratio: '1:1',
    output_format: 'jpeg',
    // The user's prompt replaces `prompt` at runtime.
  },
};
