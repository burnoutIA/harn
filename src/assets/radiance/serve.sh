#!/usr/bin/env bash
# vllm-radiance (deadcode) en une seule Radeon RDNA4, lancé par Harn (loading.mjs, recipeFor).
# Podman au premier plan : Harn suit ce processus, et l'arrêter arrête le conteneur.
# Réglages trouvés au banc sur une R9700 32 Go (2026-11-03) : DFlash2 K7, MXFP4 W4A8, KV fp8,
# vision active, 128k. Le cache KV est imposé (KV_BYTES) au lieu d'être estimé par vLLM, dont le
# profilage compte ~3 Go de trop sur cette image ; imposé, il ne tient qu'avec les correctifs
# radiance_drafthead/verifyhead montés ci-dessous (sans eux, une copie de 2,37 Gio de la tête de
# sortie fait déborder la carte dès qu'une image arrive).
# Variables : RADIANCE_DIR IMAGE PORT SERVED CTX KV_BYTES VLLM_API_KEY [HIP_DEVICE]
set -uo pipefail
: "${RADIANCE_DIR:?}" "${IMAGE:?}" "${PORT:?}" "${SERVED:?}"
CTX="${CTX:-131072}"
KV_BYTES="${KV_BYTES:-6442450944}"
NAME=harn-radiance
SITE=/opt/vllm/lib/python3.12/site-packages
ASSETS="$(cd "$(dirname "$0")" && pwd)"

# Un conteneur resté d'un arrêt brutal tiendrait encore la carte.
podman rm -f "$NAME" >/dev/null 2>&1 || true

# Les graphes compilés par vLLM ne savent pas sous quels réglages ils l'ont été : servis sous
# d'autres (vision, tête de vérification), ils ralentissent ou plantent. Un cache par image et
# par version de ce lanceur et des correctifs.
KEY=$( (printf '%s' "$IMAGE"; cat "$ASSETS"/serve.sh "$ASSETS"/*.py) | md5sum | cut -c1-12)
mkdir -p "$RADIANCE_DIR/cache/vllm-$KEY"

stop() {
  podman stop -t 15 "$NAME" >/dev/null 2>&1
  podman rm -f "$NAME" >/dev/null 2>&1
  exit 0
}
trap stop TERM INT HUP

DRAFT="{\"method\":\"dflash\",\"model\":\"/models/Qwen3.8-27B-DFlash2-FP8\",\"num_speculative_tokens\":7,\"draft_tensor_parallel_size\":1,\"attention_backend\":\"TRITON_ATTN\",\"max_model_len\":${CTX},\"disable_padded_drafter_batch\":true}"

podman run --rm --name "$NAME" \
  --device /dev/kfd --device /dev/dri --group-add keep-groups \
  --security-opt seccomp=unconfined --ipc host \
  -p "127.0.0.1:${PORT}:8000" \
  -v "$ASSETS/radiance_drafthead.py:$SITE/radiance_drafthead.py:ro" \
  -v "$ASSETS/radiance_verifyhead.py:$SITE/radiance_verifyhead.py:ro" \
  -v "$RADIANCE_DIR/models:/models:ro" -v "$RADIANCE_DIR/cache:/cache" \
  -e VLLM_API_KEY \
  -e HIP_VISIBLE_DEVICES="${HIP_DEVICE:-0}" \
  -e HIP_FORCE_DEV_KERNARG=0 -e TORCH_BLAS_PREFER_HIPBLASLT=0 \
  -e VLLM_ROCM_USE_AITER=1 -e VLLM_ROCM_USE_AITER_UNIFIED_ATTENTION=1 \
  -e VLLM_ROCM_USE_AITER_MHA=0 -e VLLM_ROCM_USE_AITER_MLA=0 -e VLLM_ROCM_USE_AITER_MOE=0 \
  -e VLLM_ROCM_USE_AITER_LINEAR=0 -e VLLM_ROCM_USE_AITER_FP8BMM=0 -e VLLM_ROCM_USE_AITER_FP4BMM=0 \
  -e VLLM_ROCM_USE_AITER_RMSNORM=0 \
  -e RADIANCE_USE_R4D=1 -e RADIANCE_USE_R4D_GDN=1 -e R4D_ATTN_FP8=0 \
  -e RADIANCE_USE_R4D_AR=0 -e RADIANCE_USE_R4D_AR_QUANT=0 \
  -e RADIANCE_SKINNY_GEMM=1 -e RADIANCE_GDN_META=1 -e RADIANCE_GDN_MERGE_INPROJ=1 \
  -e RADIANCE_GDN_FUSED_UPDATE=1 -e RADIANCE_GDN_FUSED_MAX_ITEMS=32 -e RADIANCE_GDN_SHARED_BUILD=1 \
  -e RADIANCE_TOPK_TRITON_MIN_ROWS=1 -e RADIANCE_TOPK_COMPOSITE=1 -e RADIANCE_TOPK_COMPOSITE_KCAP=64 \
  -e RADIANCE_WEIGHT_QUANTIZATION=auto \
  -e RADIANCE_MXFP4=1 -e RADIANCE_MXFP4_W4A8=1 -e RADIANCE_MXFP4_W4A8_MIN_M=0 \
  -e RADIANCE_MXFP4_DECODE_MAX_M=64 -e RADIANCE_MXFP4_TN4_MIN_M=2048 -e RADIANCE_MXFP4_EPIFAST=1 \
  -e RADIANCE_MXFP4_WPERM=1 -e RADIANCE_MXFP4_DECODE_NT=1 \
  -e RADIANCE_NORMQUANT_FUSION=0 -e RADIANCE_FP8_STREAM=0 \
  -e RADIANCE_KV_GROUP_OPT=1 -e RADIANCE_FUSE_RMS_QUANT=1 \
  -e RADIANCE_DYNAMIC_DRAFT=1 -e RADIANCE_DRAFT_SCHEDULE=1:8,2:7,4:6,8:5,16:4 -e RADIANCE_DRAFT_TAU=0.28 \
  -e RADIANCE_DYNAMIC_WIDTH=1 -e RADIANCE_DYNW_MIN_BATCH=5 \
  -e RADIANCE_QWEN_AUTO_TOOL_GRAMMAR=0 -e RADIANCE_QWEN_INT64_BOUND_COMPAT=0 \
  -e VLLM_USE_V2_MODEL_RUNNER=1 -e 'RADIANCE_COMPILATION_CONFIG={"cudagraph_mode":"PIECEWISE"}' \
  -e RADIANCE_FAST_DRAFT=1 -e RADIANCE_DRAFT_RERANK=64 -e RADIANCE_VERIFY_HEAD=1 -e RADIANCE_VERIFY_HEAD_GLOBAL_TOPK=256 \
  -e "RADIANCE_SPECULATIVE_CONFIG=$DRAFT" \
  -e TORCHINDUCTOR_COMPILE_THREADS=4 \
  -e "VLLM_CACHE_ROOT=/cache/vllm-$KEY" -e TORCHINDUCTOR_CACHE_DIR=/cache/inductor \
  -e TRITON_CACHE_DIR=/cache/triton -e AITER_ROOT_DIR=/cache/aiter -e TRITON_CACHE_AUTOTUNING=1 \
  "$IMAGE" \
  /models/Qwen3.8-27B-Quark-AWQ-MXFP4 --served-model-name="$SERVED" --tensor-parallel-size=1 \
  --max-num-seqs=1 --max-model-len="$CTX" --gpu-memory-utilization=0.98 \
  --kv-cache-memory-bytes="$KV_BYTES" \
  --max-num-batched-tokens=1024 --kv-cache-dtype=fp8 --attention-backend=R4D \
  --no-enable-prefix-caching --mamba-cache-mode=none --no-async-scheduling \
  --enable-auto-tool-choice --tool-call-parser=qwen3_coder --reasoning-parser=qwen3 \
  --generation-config=auto \
  --trust-remote-code --host=0.0.0.0 --port=8000 &
wait $!
