import json
import statistics
import time

import torch


TOKENS = 262_144
CHUNK_TOKENS = 16_384
HIDDEN = 4_096
CHUNKS = TOKENS // CHUNK_TOKENS
REPEATS = 12
DTYPE = torch.bfloat16


def measure(operation):
    start_event = torch.cuda.Event(enable_timing=True)
    end_event = torch.cuda.Event(enable_timing=True)
    torch.cuda.synchronize()
    wall_start = time.perf_counter()
    start_event.record()
    operation()
    end_event.record()
    torch.cuda.synchronize()
    return start_event.elapsed_time(end_event), (time.perf_counter() - wall_start) * 1_000


def summarize(values):
    ordered = sorted(values)
    return {
        "median_ms": statistics.median(ordered),
        "min_ms": ordered[0],
        "max_ms": ordered[-1],
        "mean_ms": statistics.mean(ordered),
    }


device_buffer = torch.empty((CHUNK_TOKENS, HIDDEN), dtype=DTYPE, device="cuda")
host_buffer = torch.empty((CHUNK_TOKENS, HIDDEN), dtype=DTYPE, pin_memory=True)
device_buffer.zero_()

# Materialize CUDA context and pinned mappings before measurement.
for _ in range(3):
    host_buffer.copy_(device_buffer, non_blocking=True)
    device_buffer.copy_(host_buffer, non_blocking=True)
torch.cuda.synchronize()


def d2h_only():
    for _ in range(CHUNKS):
        host_buffer.copy_(device_buffer, non_blocking=True)


def h2d_only():
    for _ in range(CHUNKS):
        device_buffer.copy_(host_buffer, non_blocking=True)


def roundtrip():
    for _ in range(CHUNKS):
        host_buffer.copy_(device_buffer, non_blocking=True)
        device_buffer.copy_(host_buffer, non_blocking=True)


results = {}
for name, operation in (("d2h", d2h_only), ("h2d", h2d_only), ("roundtrip", roundtrip)):
    cuda_samples = []
    wall_samples = []
    for _ in range(REPEATS):
        cuda_ms, wall_ms = measure(operation)
        cuda_samples.append(cuda_ms)
        wall_samples.append(wall_ms)
    results[name] = {
        "cuda": summarize(cuda_samples),
        "wall": summarize(wall_samples),
        "cuda_samples_ms": cuda_samples,
        "wall_samples_ms": wall_samples,
    }

bytes_one_way = TOKENS * HIDDEN * torch.tensor([], dtype=DTYPE).element_size()
roundtrip_median_s = results["roundtrip"]["wall"]["median_ms"] / 1_000
output = {
    "gpu": torch.cuda.get_device_name(),
    "tokens": TOKENS,
    "chunk_tokens": CHUNK_TOKENS,
    "chunks": CHUNKS,
    "hidden": HIDDEN,
    "dtype": str(DTYPE),
    "bytes_one_way": bytes_one_way,
    "gib_one_way": bytes_one_way / 2**30,
    "gib_roundtrip": bytes_one_way * 2 / 2**30,
    "effective_roundtrip_gib_s": (bytes_one_way * 2 / 2**30) / roundtrip_median_s,
    "results": results,
}
print(json.dumps(output, indent=2))
