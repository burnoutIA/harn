// Les modèles de voix (synthèse vocale) que Harn sait servir, tous par vLLM-Omni : un seul moteur
// pour tous, chaque modèle avec ses poids sous models/voice/<id>. Comme pour les images
// (image-families.mjs), un modèle appartient à une famille : elle dit comment le lancer (la
// deploy-config de vLLM-Omni) et comment lui demander de parler. Un dépôt Hugging Face d'une
// famille connue s'ajoute tel quel (addVoiceModel) : un réglage fin de Qwen3-TTS, la version
// CustomVoice, etc.
//
// Deux sortes de voix :
//   - preset : le modèle a ses voix à lui (Voxtral : fr_female… ; Qwen3-TTS CustomVoice : vivian…) ;
//   - clone : le modèle n'a aucune voix, il imite un extrait audio donné à chaque requête
//     (Qwen3-TTS Base). Les extraits sont les « voix clonées » de Harn (voice.mjs, data/voices).

// Le texte en jetons plus 12,5 trames d'audio par seconde : 2048 couvrent ~2 min de parole.
const VOXTRAL_LEN = 2048;

export const VOICE_FAMILIES = [
  {
    id: 'voxtral',
    name: 'Voxtral TTS',
    match: /voxtral.*tts/,
    // Mesuré sur une 3090 : le premier étage (modèle de langue et transformeur acoustique, poids
    // compressés en fp8 au chargement) ~5,7 Go, le second (codec) ~1 Go, plus le contexte CUDA de
    // chaque processus. En dessous de 5,2 Go pour le premier, vLLM refuse de démarrer.
    stageMiB: () => [5800, 1000],
    needMiB: () => 8800,
    kind: () => 'preset',
    presetVoices: () => ['fr_female', 'fr_male'],
    // La deploy-config d'origine (vllm_omni/deploy/voxtral_tts.yaml) réécrite en entier : elle
    // demande les formats de Mistral et la compression fp8 n'y est pas.
    deploy: ({ share }) => `# Écrit par Harn (src/voice-models.mjs) : Voxtral à côté du modèle de texte.
async_chunk: true
connectors:
  connector_of_shared_memory:
    name: SharedMemoryConnector
    extra:
      codec_streaming: true
      connector_get_sleep_s: 0.01
      connector_get_max_wait_first_chunk: 3000
      connector_get_max_wait: 300
      codec_chunk_frames: 25
      codec_chunk_frames_at_begin: 5
      codec_left_context_frames: 25
stages:
  - stage_id: 0
    max_num_batched_tokens: ${VOXTRAL_LEN}
    max_num_seqs: 1
    gpu_memory_utilization: ${share[0]}
    enforce_eager: false
    quantization: fp8
    async_scheduling: true
    max_model_len: ${VOXTRAL_LEN}
    enable_chunked_prefill: false
${voxtralCommon}
    output_connectors:
      to_stage_1: connector_of_shared_memory
    default_sampling_params:
      temperature: 0.0
      top_p: 1.0
      top_k: -1
      max_tokens: ${VOXTRAL_LEN}
      seed: 42
      repetition_penalty: 1.1
      extra_args:
        cfg_alpha: 1.2
  - stage_id: 1
    max_num_batched_tokens: 8192
    max_num_seqs: 1
    gpu_memory_utilization: ${share[1]}
    enforce_eager: true
    async_scheduling: false
    max_model_len: 8192
${voxtralCommon}
    input_connectors:
      from_stage_0: connector_of_shared_memory
    default_sampling_params:
      temperature: 0.9
      top_p: 0.8
      top_k: 40
      max_tokens: ${VOXTRAL_LEN}
      seed: 42
      repetition_penalty: 1.05
`,
    // L'API n'a pas de paramètre de langue : la voix choisie la donne.
    request: ({ voice }) => ({ voice }),
  },
  {
    id: 'qwen3-tts',
    name: 'Qwen3-TTS',
    match: /qwen3-tts/,
    // Le talker (étage 0) porte le modèle de langue, le code2wav (étage 1) le décodeur de son,
    // sans cache. Mesuré sur une 3090 pour le 1.7B (2026-11-22) : 5,5 Go et 1,3 Go, contexte CUDA
    // compris. Le 0.6B : estimé d'après lui. La deploy-config d'origine en demande 30 % chacun
    // d'une H100.
    stageMiB: ({ size }) => (size === '0b6' ? [3500, 1500] : [5000, 1500]),
    needMiB: ({ size }) => (size === '0b6' ? 5500 : 7200),
    // tts_model_type du config.json : base (clonage), custom_voice (voix fournies), voice_design
    // (voix décrite par une consigne, que Harn ne sait pas encore demander).
    kind: ({ ttsType }) => (ttsType === 'base' ? 'clone' : ttsType === 'custom_voice' ? 'preset' : null),
    presetVoices: ({ speakers }) => speakers ?? [],
    // Le profil d'origine (vllm_omni/deploy/qwen3_tts.yaml, avec ses réglages ROCm et NPU), ramené
    // à une requête à la fois et à sa part de la carte.
    deploy: ({ share, deployDir }) => `# Écrit par Harn (src/voice-models.mjs) : Qwen3-TTS à côté du modèle de texte.
base_config: ${deployDir}/qwen3_tts.yaml
stages:
  - stage_id: 0
    max_num_seqs: 1
    gpu_memory_utilization: ${share[0]}
  - stage_id: 1
    max_num_seqs: 1
    gpu_memory_utilization: ${share[1]}
`,
    // Une phrase dite au démarrage : la première vraie phrase part ensuite aussi vite que les
    // autres (2,2 s sinon, contre ~0,1 s). Base : le timbre d'un extrait sans transcription.
    warmup: ({ kind, presets, silence }) => (kind === 'clone'
      ? { task_type: 'Base', language: 'French', ref_audio: silence, x_vector_only_mode: true }
      : { task_type: 'CustomVoice', language: 'French', voice: presets[0] }),
    // Base : l'extrait et sa transcription (sans elle, seul le timbre est pris : x_vector_only_mode).
    request: ({ kind, voice, sample, language }) => (kind === 'clone'
      ? { task_type: 'Base', language, ref_audio: sample.audio, ...(sample.text ? { ref_text: sample.text } : { x_vector_only_mode: true }) }
      : { task_type: 'CustomVoice', language, voice }),
  },
];

const voxtralCommon = `    trust_remote_code: true
    enable_prefix_caching: false
    devices: "0"
    tokenizer_mode: mistral
    config_format: mistral
    load_format: mistral
    skip_mm_profiling: true`;

export const voiceFamilyById = (id) => VOICE_FAMILIES.find((family) => family.id === id) ?? null;
const normalize = (text) => String(text).toLowerCase().replace(/[_\s]+/g, '-');
export const voiceFamilyOf = ({ repo = '', modelType = '' }) => VOICE_FAMILIES.find((family) => family.match.test(normalize(`${modelType.replace(/_/g, '-')} ${repo}`))) ?? null;

// Les modèles proposés d'office. revision : figée, pour que deux machines servent la même chose.
// size, ttsType, speakers : ce que dit leur config.json (relu pour un modèle ajouté).
export const VOICE_MODELS = [
  {
    id: 'qwen3-tts-1.7b-base', name: 'Qwen3-TTS 1.7B Base', family: 'qwen3-tts',
    repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', revision: 'fd4b254389122332181a7c3db7f27e918eec64e3',
    size: '1b7', ttsType: 'base', license: 'Apache-2.0', gigabytes: 4.5,
    tagline: 'Imite la voix d’un extrait de quelques secondes. Dix langues, dont le français.',
  },
  {
    id: 'qwen3-tts-0.6b-base', name: 'Qwen3-TTS 0.6B Base', family: 'qwen3-tts',
    repo: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', revision: '5d83992436eae1d760afd27aff78a71d676296fc',
    size: '0b6', ttsType: 'base', license: 'Apache-2.0', gigabytes: 2.5,
    tagline: 'La petite version du 1.7B : même clonage de voix, moins de mémoire, un peu moins fidèle.',
  },
  {
    id: 'voxtral', name: 'Voxtral TTS 4B', family: 'voxtral',
    repo: 'mistralai/Voxtral-4B-TTS-2603', revision: 'b81be46c3777f88621676791b512bb01dc1cb970',
    license: 'CC BY-NC 4.0 (usage non commercial)', gigabytes: 8,
    tagline: 'Les voix de Mistral (fr_female, fr_male) : naturelle, sans extrait à fournir.',
  },
];

// Ce que la famille dit d'un modèle : sa sorte de voix, ses voix, sa place sur la carte.
export function describeVoiceModel(model) {
  const family = voiceFamilyById(model.family);
  const kind = family?.kind(model) ?? null;
  return { family, kind, presets: kind === 'preset' ? family.presetVoices(model) : [], needMiB: family?.needMiB(model) ?? null };
}

// Un dépôt Hugging Face : sa famille et ce qu'il faut savoir pour le servir, d'après config.json.
// problem : pourquoi Harn ne saurait pas le servir.
export async function inspectVoiceRepo(repo, fetcher = fetch) {
  const headers = { 'User-Agent': 'harn' };
  const info = await fetcher(`https://huggingface.co/api/models/${repo}?blobs=true`, { headers, signal: AbortSignal.timeout(20_000) })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.status === 404 ? 'Dépôt introuvable (ou privé)' : `Hugging Face a répondu ${res.status}`))));
  const config = await fetcher(`https://huggingface.co/${repo}/resolve/${info.sha}/config.json`, { headers, signal: AbortSignal.timeout(20_000) })
    .then((res) => (res.ok ? res.json() : {}), () => ({}));
  const family = voiceFamilyOf({ repo, modelType: config.model_type ?? '' });
  const bytes = (info.siblings ?? []).reduce((sum, file) => sum + (file.size ?? 0), 0);
  const model = {
    repo, revision: info.sha, family: family?.id ?? null,
    name: repo.split('/')[1].replace(/[-_]+/g, ' '),
    license: info.cardData?.license ?? null,
    gigabytes: +(bytes / 1e9).toFixed(1),
    size: config.tts_model_size ?? null,
    ttsType: config.tts_model_type ?? null,
    speakers: Object.keys(config.talker_config?.spk_id ?? {}),
  };
  let problem = null;
  if (!family) problem = `Famille non reconnue (${config.model_type ?? 'config.json absent'}) : Harn sert ${VOICE_FAMILIES.map((f) => f.name).join(' et ')}`;
  else if (!family.kind(model)) problem = `${family.name} « ${model.ttsType} » : Harn ne sait pas encore demander ce genre de voix`;
  else if (info.gated) problem = 'Dépôt à accès restreint : Harn ne télécharge pas ceux-là';
  return { model, problem };
}
