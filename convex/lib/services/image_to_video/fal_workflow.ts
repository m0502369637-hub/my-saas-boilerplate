// lib/services/image_to_video/fal_workflow.ts — model id + payload template.
// The service merges this template + config + the uploaded image_url at
// submit time. Full input schema:
// https://fal.ai/models/fal-ai/veo3.1/image-to-video
export const model = "fal-ai/veo3.1/image-to-video";

export const inputTemplate = {
  prompt: "gentle cinematic zoom",
  aspect_ratio: "auto", // 'auto' | '16:9' | '9:16'
  duration: "8s", // '4s' | '6s' | '8s'
  resolution: "720p", // '720p' | '1080p' | '4k'
  generate_audio: false, // audio doubles the provider cost
  // image_url is injected at runtime from the user's uploaded photo.
} as const;
