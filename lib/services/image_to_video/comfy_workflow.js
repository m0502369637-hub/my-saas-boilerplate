// lib/services/image_to_video/comfy_workflow.js — ComfyUI API-format workflow.
//
// Kept as a JS module because the platform deploys ONLY .js files under
// lib/ (no JSON assets). The object below is exactly what ComfyUI's
// "Save (API Format)" exports — node id → { class_type, inputs, _meta }.
//
// TO USE YOUR OWN WORKFLOW:
//   1. Build it in the ComfyUI web UI (LoadImage → CLIPTextEncode ×2 →
//      KSampler → VAEDecode → VHS_VideoCombine, or your own graph).
//   2. Menu → "Save (API Format)" → paste the JSON object here, replacing
//      this placeholder.
//   3. lib/comfyui.js injects inputs by walking the graph and matching
//      class_type (see config.js → comfyui.inputNodes), so node ids can be
//      anything — only the class names matter.
//
// PLACEHOLDER GRAPH — a minimal, realistic image→video skeleton. Node ids
// ("4", "6", …) and the model/clip/vae references (["4",0], ["9",0], …) are
// illustrative: replace them with the values from your own export, and make
// sure the referenced model/clip/vae nodes exist in your graph.
export default {
  '10': {
    class_type: 'LoadImage',
    inputs: { image: 'INPUT_IMAGE', upload: 'image' },
    _meta: { title: 'Load Image' },
  },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'PROMPT_PLACEHOLDER', clip: ['30', 0] },
    _meta: { title: 'Positive Prompt' },
  },
  '7': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'blurry, low quality, deformed', clip: ['30', 0] },
    _meta: { title: 'Negative Prompt' },
  },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 12345,
      steps: 20,
      cfg: 8,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 0.7,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
    _meta: { title: 'KSampler' },
  },
  '8': {
    class_type: 'VAEDecode',
    inputs: { samples: ['3', 0], vae: ['9', 0] },
    _meta: { title: 'VAE Decode' },
  },
  '11': {
    class_type: 'VHS_VideoCombine',
    inputs: {
      images: ['8', 0],
      frame_rate: 8,
      loop_count: 0,
      filename_prefix: 'SaasGen',
      format: 'video/h264-mp4',
      pingpong: false,
      save_output: true,
    },
    _meta: { title: 'Video Combine' },
  },
};
