// lib/services/image_to_video/config.js — every knob of the service.
//
// This is the file you edit when you clone the folder for a new service, and
// the file you flip when switching providers.
import { secrets } from 'lib/secrets';

export default {
  name: 'image_to_video',
  cost: 100,                            // Stars per generation (internal wallet)
  provider: secrets.provider || 'fal_ai', // 'fal_ai' | 'comfyui'
  maxJobAgeMs: 15 * 60 * 1000,          // 15 min → auto-timeout + refund
  pollAfterMs: 60 * 1000,               // poll the provider at most once per minute

  fal: {
    // Verified live: https://fal.ai/models/fal-ai/veo3.1/image-to-video
    model: 'fal-ai/veo3.1/image-to-video',
    prompt: 'gentle cinematic zoom',    // default creative prompt (merged at submit)
    duration: '8s',                     // '4s' | '6s' | '8s'
    resolution: '720p',                 // '720p' | '1080p' (4k is also supported)
    generateAudio: false,               // audio doubles the provider's per-second price
  },

  comfyui: {
    // Module (bare name) under this folder holding the API-format workflow
    // exported from ComfyUI via "Save (API Format)".
    workflowFile: 'comfy_workflow',
    // Which node classes receive dynamic inputs — the graph is walked and
    // matched by class_type, so any exported workflow works.
    inputNodes: {
      image: 'LoadImage',
      prompt: 'CLIPTextEncode',
      seed: 'KSampler',
    },
    outputNode: 'VHS_VideoCombine',
    seed: 12345,   // fixed for reproducibility; null → workflow's own value
    steps: null,   // null → keep the workflow's own value
  },
};
