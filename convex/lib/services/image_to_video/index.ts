import { injectWorkflow } from "../../providers/comfyui";
import type { ImageRefs, JobInput, ProviderPayload, Service } from "../types";
import { comfyuiConfig, config } from "./config";

// lib/services/image_to_video/index.ts — the worked-example service.
//
// PURE module: buildProviderPayload() only merges the deploy-time payload
// (PROVIDER_PAYLOAD env var) with the runtime photo. No workflow samples and
// no network/DB access here — all I/O lives in the generic plumbing.

export const imageToVideo: Service = {
  config,
  buildProviderPayload(
    payload: Record<string, unknown>,
    _input: JobInput,
    images: ImageRefs,
  ): ProviderPayload {
    if (config.provider === "comfyui") {
      // payload = { workflow: { …ComfyUI API-format graph… } }
      const workflow = (payload.workflow ?? payload) as Record<string, unknown>;
      const graph = injectWorkflow(workflow, {
        image: images.comfyName ?? null,
        seed: comfyuiConfig.seed,
        steps: comfyuiConfig.steps,
        imageNode: comfyuiConfig.inputNodes.image,
        promptNode: comfyuiConfig.inputNodes.prompt,
        seedNode: comfyuiConfig.inputNodes.seed,
      });
      return { kind: "comfyui", workflow: graph };
    }

    // payload = { model: "fal-ai/…", input: { …model input template… } }
    const model = payload.model;
    if (typeof model !== "string" || !model) {
      throw new Error('PROVIDER_PAYLOAD is missing a "model" string (fal service)');
    }
    const template = (payload.input ?? {}) as Record<string, unknown>;
    const finalInput: Record<string, unknown> = { ...template };
    if (images.falUrl) finalInput.image_url = images.falUrl; // the user's photo
    return { kind: "fal", model, input: finalInput };
  },
};
