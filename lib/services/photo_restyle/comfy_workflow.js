// lib/services/photo_restyle/comfy_workflow.js — ComfyUI API-format workflow.
//
// Placeholder img2img skeleton: LoadImage → CLIPTextEncode (pos/neg) →
// KSampler → VAEDecode → SaveImage. Replace with your own "Save (API
// Format)" export; lib/comfyui.js injects inputs by class_type, so node ids
// can be anything — only the class names matter (see config.js →
// comfyui.inputNodes). The model/clip/vae references (["4",0], ["9",0], …)
// must point at nodes that exist in YOUR exported graph.
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
      seed: 0,
      steps: 20,
      cfg: 8,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 0.6,
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
  '12': {
    class_type: 'SaveImage',
    inputs: { images: ['8', 0], filename_prefix: 'Restyle' },
    _meta: { title: 'Save Image' },
  },
};
