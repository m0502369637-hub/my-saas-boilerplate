// lib/services/image_to_video/config.ts — every knob of the worked-example
// service. Clone this folder for a new service and edit this file first.
//
// The provider payload (fal model + input template, or the ComfyUI workflow
// graph) is NOT here — it is supplied at deploy time via the PROVIDER_PAYLOAD
// env var. This repo never ships sample workflows.
import type { ServiceConfig } from "../types";

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

// ComfyUI injection knobs — how runtime inputs are merged into YOUR workflow
// (matched by class_type; see lib/providers/comfyui.ts#injectWorkflow).
// These are wiring, not a workflow: the graph itself comes from
// PROVIDER_PAYLOAD.
export const comfyuiConfig = {
  inputNodes: {
    image: "LoadImage",
    prompt: "CLIPTextEncode",
    seed: "KSampler",
  },
  seed: null as number | null, // null → keep the workflow's own seed
  steps: null as number | null, // null → keep the workflow's own value
};
