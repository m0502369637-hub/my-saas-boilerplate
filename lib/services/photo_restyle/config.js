// lib/services/photo_restyle/config.js — knobs for the photo-restyle service.
//
// ComfyUI-backed img2img: the user's photo is uploaded to the ComfyUI server,
// the workflow's LoadImage node gets its file name, and the result comes out
// of a SaveImage node (image output — the boilerplate auto-detects the kind).
import { secrets } from 'lib/secrets';

export default {
  name: 'photo_restyle',
  cost: 75,                             // Stars per generation
  provider: secrets.provider || 'comfyui', // 'fal_ai' | 'comfyui'
  maxJobAgeMs: 15 * 60 * 1000,          // 15 min → auto-timeout + refund
  pollAfterMs: 60 * 1000,               // poll the provider at most once per minute

  comfyui: {
    // Module (bare name) under this folder holding the API-format workflow
    // exported from ComfyUI via "Save (API Format)".
    workflowFile: 'comfy_workflow',
    // Which node classes receive dynamic inputs — matched by class_type.
    inputNodes: {
      image: 'LoadImage',
      prompt: 'CLIPTextEncode',
      seed: 'KSampler',
    },
    outputNode: 'SaveImage',
    prompt: 'restyle as a vibrant anime illustration, clean lines, bold colors',
    seed: null,    // null → KSampler's own random seed every run
    steps: null,   // null → keep the workflow's own value
  },
};
