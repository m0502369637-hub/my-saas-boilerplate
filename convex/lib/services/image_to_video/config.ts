import type { ServiceConfig } from "../types";

// lib/services/image_to_video/config.ts — every knob of the worked-example
// service. Clone this folder for a new service and edit this file first.
export const config: ServiceConfig = {
  name: "image_to_video",
  title: "🎬 Image → Video",
  description: "Send a photo and I'll turn it into a short video — 100 ⭐ per generation.",
  cost: 100, // Stars per generation (internal wallet)
  provider: "fal", // 'fal' | 'comfyui'
  maxJobAgeMs: 15 * 60 * 1000, // 15 min → auto-timeout + refund
  pollAfterMs: 60 * 1000, // poll the provider at most once per minute
  trigger: { kind: "photo" },
};

// Provider-specific knobs (kept out of ServiceConfig to stay provider-agnostic).
export const falConfig = {
  // Verified live: https://fal.ai/models/fal-ai/veo3.1/image-to-video
  model: "fal-ai/veo3.1/image-to-video",
  prompt: "gentle cinematic zoom", // default creative prompt
  duration: "8s", // '4s' | '6s' | '8s'
  resolution: "720p", // '720p' | '1080p' (4k also supported)
  generateAudio: false, // audio doubles the provider's per-second price
};

export const comfyuiConfig = {
  inputNodes: {
    image: "LoadImage",
    prompt: "CLIPTextEncode",
    seed: "KSampler",
  },
  outputNode: "VHS_VideoCombine",
  seed: 12345, // fixed for reproducibility; null → workflow's own value
  steps: null, // null → keep the workflow's own value
};
