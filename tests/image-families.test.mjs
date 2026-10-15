import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { IMAGE_FAMILIES, bestQuant, companionsFor, diffusionVariants, familyOf, memoryNeeds, notImageModel } from '../src/image-families.mjs';
import { IMAGE_MODELS } from '../src/images.mjs';

const GB = 1e9;

test('la famille se lit dans le fichier, le dépôt, puis les tags base_model', () => {
  const cases = [
    [{ repo: 'leejet/Z-Image-Turbo-GGUF', file: 'z_image_turbo' }, 'z-image-turbo'],
    [{ repo: 'unsloth/Z-Image-GGUF', file: 'z-image' }, 'z-image'],
    [{ repo: 'leejet/FLUX.2-klein-9B-GGUF', file: 'flux-2-klein-9b' }, 'flux2-klein-9b'],
    [{ repo: 'leejet/FLUX.2-klein-4B-GGUF', file: 'flux-2-klein-4b' }, 'flux2-klein-4b'],
    [{ repo: 'x/FLUX.2-klein-9B-GGUF', file: 'flux2-klein' }, 'flux2-klein-9b'],
    [{ repo: 'leejet/FLUX.2-klein-base-9B-GGUF', file: 'flux-2-klein-base-9b' }, 'flux2-klein-base-9b'],
    [{ repo: 'Abiray/flux-3-image-klein-sd-GGUF', file: 'flux3_image_klein_sd' }, 'flux3-klein'],
    [{ repo: 'city96/FLUX.1-dev-gguf', file: 'flux1-dev' }, 'flux1-dev'],
    [{ repo: 'city96/FLUX.1-schnell-gguf', file: 'flux1-schnell' }, 'flux1-schnell'],
    [{ repo: 'QuantStack/FLUX.1-Kontext-dev-GGUF', file: 'flux1-kontext-dev' }, 'flux1-kontext'],
    [{ repo: 'silveroxides/Chroma-GGUF', file: 'Chroma1-HD/Chroma1-HD' }, 'chroma'],
    [{ repo: 'abenzerps/Qwen-Image-2.1-Uncensored-Quantized', file: 'qwen-image-2.1-UC' }, 'qwen-image-2.1'],
    [{ repo: 'AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF', file: 'model', baseModels: ['Qwen/Qwen3-VL-8B-Instruct'] }, 'qwen-image-2.1-turbo'],
    [{ repo: 'unsloth/Qwen-Image-Edit-2511-GGUF', file: 'qwen-image-edit-2511' }, 'qwen-image-edit-2511'],
    [{ repo: 'QuantStack/Qwen-Image-Edit-2509-GGUF', file: 'Qwen-Image-Edit-2509' }, 'qwen-image-edit'],
    [{ repo: 'unsloth/Qwen-Image-2512-GGUF', file: 'qwen-image-2512' }, 'qwen-image'],
    [{ repo: 'realrebelai/KREA-2_GGUFs', file: 'BASE/Krea-2-Base', baseModels: ['krea/Krea-2-Turbo'] }, 'krea2'],
    [{ repo: 'realrebelai/KREA-2_GGUFs', file: 'TURBO/Krea-2-Turbo' }, 'krea2-turbo'],
    [{ repo: 'unsloth/ERNIE-Image-Turbo-GGUF', file: 'ernie-image-turbo' }, 'ernie-image-turbo'],
    // Un dérivé au nom libre : seul son tag base_model dit d'où il vient.
    [{ repo: 'SeeSee21/Z-Anime', file: 'z-anime', baseModels: ['Tongyi-MAI/Z-Image'] }, 'z-image'],
  ];
  for (const [input, expected] of cases) assert.equal(familyOf(input)?.id, expected, JSON.stringify(input));
  assert.equal(familyOf({ repo: 'molbal/ideogram-4-gguf', file: 'ideogram4-transformer' }), null);
  assert.equal(familyOf({ repo: 'x/Chroma1-Radiance-GGUF', file: 'chroma1-radiance' }), null);
});

test('les poids de diffusion sont regroupés par variante, sans lecteurs de consigne ni décodeurs', () => {
  const files = [
    ['z_image_turbo-Q4_K.gguf', 3.9], ['z_image_turbo-Q8_0.gguf', 6.6], ['z_image_turbo-BF16.gguf', 12.3],
    ['vae/qwen_image_2.1_vae_bf16.safetensors', 0.7], ['text_encoders/Qwen3-4B-Q8_0.gguf', 4.3],
    ['mmproj-F16.gguf', 0.9], ['Qwen3-4B-Q8_0.gguf', 4.3], ['big-00001-of-00002.gguf', 10],
    ['BASE/Krea-2-Base-Q8_0.gguf', 13.7], ['TURBO/Krea-2-Turbo-Q8_0.gguf', 13.7],
  ].map(([name, gb]) => ({ name, bytes: gb * GB }));
  const variants = diffusionVariants(files);
  assert.deepEqual(variants.map((v) => v.stem), ['z_image_turbo', 'BASE/Krea-2-Base', 'TURBO/Krea-2-Turbo']);
  assert.deepEqual(variants[0].quants.map((q) => q.quant), ['Q4_K', 'Q8_0', 'BF16']);
});

test('la version choisie est la plus grosse qui tient, Q8 au plus', () => {
  const variant = { quants: [['Q4_K', 3.9], ['Q8_0', 6.6], ['BF16', 12.3]].map(([quant, gb]) => ({ quant, bytes: gb * GB })) };
  assert.equal(bestQuant(variant, 24).quant, 'Q8_0');
  assert.equal(bestQuant(variant, 8).quant, 'Q4_K');
  assert.equal(bestQuant(variant, 4), null);
  assert.equal(bestQuant({ quants: [{ quant: 'BF16', bytes: 12.3 * GB }] }, 24).quant, 'BF16');
  // La plus grosse partie doit tenir sur la carte ; toutes ensemble en mémoire vive.
  assert.deepEqual(memoryNeeds(6 * 1024 ** 3, [8 * 1024 ** 3, 0.3 * 1024 ** 3]), { vramGiB: 9, ramGiB: 18.3 });
});

test('chaque famille a son décodeur et un lecteur de consigne, plus petit sur une petite carte', () => {
  for (const family of IMAGE_FAMILIES) {
    const files = companionsFor(family, 24);
    const roles = files.map((f) => f.role);
    assert.ok(roles.includes('vae'), family.id);
    assert.ok(roles.includes('llm') || roles.includes('t5xxl'), family.id);
    assert.ok(files.every((f) => f.shared && /^[\w.-]+\/[\w.-]+$/.test(f.repo) && f.name), family.id);
  }
  const klein = IMAGE_FAMILIES.find((f) => f.id === 'flux2-klein-9b');
  assert.match(companionsFor(klein, 24).find((f) => f.role === 'llm').name, /Q8_0/);
  assert.match(companionsFor(klein, 8).find((f) => f.role === 'llm').name, /Q4_K_M/);
  // Les modèles proposés par Harn appartiennent à une famille connue.
  for (const model of IMAGE_MODELS) assert.ok(IMAGE_FAMILIES.some((f) => f.id === model.family), model.id);
});

test('un dépôt de lecteur de consigne ou de LoRA n’est pas un modèle d’images', () => {
  assert.ok(notImageModel('ponpoke/flux2-klein-9b-uncensored-text-encoder'));
  assert.ok(notImageModel('someone/flux-lora-collection'));
  assert.ok(!notImageModel('leejet/Z-Image-Turbo-GGUF'));
  assert.ok(!notImageModel('silveroxides/Chroma-GGUF'));
});
