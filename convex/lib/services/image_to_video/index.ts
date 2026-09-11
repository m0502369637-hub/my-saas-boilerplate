import { injectWorkflow } from "../../providers/comfyui";
import type { ImageRefs, JobInput, ProviderPayload, Service } from "../types";
import { comfyuiConfig, config, falConfig } from "./config";
import { inputTemplate, model } from "./fal_workflow";
import { workflow } from "./comfy_workflow";

// lib/services/image_to_video/index.ts — the worked-example service.
//
// PURE module: buildProviderPayload() only assembles the submission payload.
// All I/O (photo download, provider upload/submit, polling, delivery) lives in
// the generic plumbing — this file never touches the network or the DB.

export const imageToVideo: Service = {
  config,
  buildProviderPayload(input: JobInput, images: ImageRefs): ProviderPayload {
    if (config.provider === "comfyui") {
      const graph = injectWorkflow(workflow, {
        image: images.comfyName ?? null,
        prompt: falConfig.prompt,
        seed: comfyuiConfig.seed,
        steps: comfyuiConfig.steps,
        imageNode: comfyuiConfig.inputNodes.image,
        promptNode: comfyuiConfig.inputNodes.prompt,
        seedNode: comfyuiConfig.inputNodes.seed,
      });
      return { kind: "comfyui", workflow: graph };
    }

    return {
      kind: "fal",
      model: falConfig.model ?? model,
      input: {
        ...inputTemplate,
        image_url: images.falUrl,
        prompt: falConfig.prompt,
        duration: falConfig.duration,
        resolution: falConfig.resolution,
        generate_audio: falConfig.generateAudio,
      },
    };
  },
};
