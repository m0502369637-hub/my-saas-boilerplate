// lib/services/image_to_video/fal_workflow.js — Fal model id + payload template.
//
// Kept as a JS module because the platform deploys ONLY .js files under
// lib/ (no JSON assets). The service merges this template + config.fal +
// the uploaded image_url at submit time.
//
// Full input schema: https://fal.ai/models/fal-ai/veo3.1/image-to-video
// Pricing note: $0.20/s (no audio) at 720p — keep duration/resolution in
// line with the 100 ⭐ price you charge.
export default {
  model: 'fal-ai/veo3.1/image-to-video',
  input: {
    prompt: 'gentle cinematic zoom',
    aspect_ratio: 'auto',   // 'auto' | '16:9' | '9:16'
    duration: '8s',         // '4s' | '6s' | '8s'
    resolution: '720p',     // '720p' | '1080p' | '4k'
    generate_audio: false,  // audio doubles the provider cost
    // image_url is injected at runtime from the user's uploaded photo.
  },
};
