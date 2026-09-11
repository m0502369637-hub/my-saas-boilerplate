// lib/services/text_to_image/config.js — knobs for the text→image service.
import { secrets } from 'lib/secrets';

export default {
  name: 'text_to_image',
  cost: 50,                             // Stars per generation (half the video service)
  provider: secrets.provider || 'fal_ai', // 'fal_ai' | 'comfyui'
  maxJobAgeMs: 5 * 60 * 1000,           // FLUX is fast — a shorter window than video
  pollAfterMs: 60 * 1000,               // poll the provider at most once per minute

  fal: {
    // Verified live: https://fal.ai/models/fal-ai/flux-pro/v1.1-ultra
    // $0.06 per image — a 50 ⭐ price covers it with margin.
    model: 'fal-ai/flux-pro/v1.1-ultra',
    numImages: 1,          // 1–4
    aspectRatio: '1:1',    // '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | …
    outputFormat: 'jpeg',  // 'jpeg' | 'png'
  },

  // A ComfyUI-backed text→image would need only this section + a workflow
  // whose CLIPTextEncode/KSampler nodes match; the output node would be
  // 'SaveImage' (see photo_restyle for the image-output pattern).
  comfyui: {
    workflowFile: 'comfy_workflow',
    inputNodes: { image: 'LoadImage', prompt: 'CLIPTextEncode', seed: 'KSampler' },
    outputNode: 'SaveImage',
  },
};
