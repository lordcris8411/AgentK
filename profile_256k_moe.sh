#!/usr/bin/env bash
set -euo pipefail

root=/opt/lvllmds4-x
tuning="$root/sm89-tuning"
test_root="$tuning/nvcomp-test"
report="$test_root/profile-256k-moe"
profiler_pid=""

restore_service() {
    if [[ -n "$profiler_pid" ]] && kill -0 "$profiler_pid" 2>/dev/null; then
        kill -INT "$profiler_pid" 2>/dev/null || true
        timeout 60 tail --pid="$profiler_pid" -f /dev/null || true
        kill -TERM "$profiler_pid" 2>/dev/null || true
    fi
    pkill -TERM -f '/opt/lvllmds4-x/venv/bin/vllm serve.*--port 8070' 2>/dev/null || true
    systemctl start lvllmds4-x || true
}
trap restore_service EXIT

systemctl stop lvllmds4-x
rm -f "$report.nsys-rep" "$report.sqlite" \
      "$test_root/profile-256k-server.log" \
      "$test_root/profile-256k-request.jsonl"

cd "$root"
env \
    CUDA_VISIBLE_DEVICES=0 \
    CUDA_HOME="$root/venv/lib/python3.12/site-packages/nvidia/cu13" \
    LD_LIBRARY_PATH="$root/venv/lib/python3.12/site-packages/nvidia/cu13/lib" \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    LVLLM_MOE_NUMA_ENABLED=1 \
    LVLLM_GPU_PREFILL_MIN_BATCH_SIZE=4096 \
    LVLLM_GPU_RESIDENT_MOE_LAYERS=0-2 \
    LK_THREADS=60 OMP_NUM_THREADS=60 LK_THREAD_BINDING=CPU_CORE \
    LVLLM_GPU_PREFETCH_WINDOW=1 LK_POWER_SAVING=0 \
    FLASHINFER_DISABLE_VERSION_CHECK=1 VLLM_USE_FLASHINFER_SAMPLER=1 \
    VLLM_DSV4_SM89_C128_BF16_SCORES=1 \
    VLLM_DSV4_SM89_C128_SCORE_CHUNK=8192 \
    VLLM_DSV4_SM89_C128_VALUE_HEAD64=1 \
    VLLM_DSV4_SM89_C0_TC_ATTENTION=1 \
    VLLM_DSV4_SM89_O_PROJ=1 \
    VLLM_DSV4_SM89_QB_PROJ=1 \
    VLLM_DSV4_SM89_NATIVE_FP8_INDEXER=1 \
    VLLM_MARLIN_INPUT_DTYPE=fp8 \
    nsys profile --trace=cuda,nvtx --sample=none --cpuctxsw=none \
        --force-overwrite=true --output="$report" \
        "$root/venv/bin/vllm" serve /root/DeepSeek-V4-Flash-0731 \
        --host 0.0.0.0 --port 8070 --tensor-parallel-size 1 \
        --max-model-len 524288 --gpu-memory-utilization 0.90 \
        --trust-remote-code --served-model-name DeepSeek-V4-Flash-0731 \
        --compilation_config.cudagraph_mode FULL_DECODE_ONLY \
        --enable-prefix-caching --enable-chunked-prefill \
        --max-num-batched-tokens 16384 --dtype bfloat16 --max-num-seqs 1 \
        --enable-auto-tool-choice --kv-cache-dtype fp8_ds_mla \
        --tokenizer-mode deepseek_v4 --tool-call-parser deepseek_v4 \
        --reasoning-parser deepseek_v4 \
        --default-chat-template-kwargs '{"enable_thinking": true}' \
        --speculative-config '{"method":"dspark","num_speculative_tokens":5,"draft_sample_method":"probabilistic"}' \
        --disable-custom-all-reduce \
        >"$test_root/profile-256k-server.log" 2>&1 &
profiler_pid=$!

for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 http://127.0.0.1:8070/health >/dev/null; then
        break
    fi
    sleep 5
done
curl -fsS --max-time 2 http://127.0.0.1:8070/health >/dev/null

"$root/venv/bin/python" "$tuning/quality_full_model_sm89.py" \
    --label profile_baseline --skip-short --skip-16k \
    --output "$test_root/profile-256k-request.jsonl"

kill -INT "$profiler_pid"
timeout 120 tail --pid="$profiler_pid" -f /dev/null
profiler_pid=""
systemctl start lvllmds4-x
trap - EXIT
