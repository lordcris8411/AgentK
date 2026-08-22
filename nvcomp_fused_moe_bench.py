#!/usr/bin/env python3
import ctypes
import gc
import json
import statistics
from pathlib import Path

import torch
from safetensors.torch import load_file

from vllm.model_executor.layers.fused_moe.config import fp8_w8a8_moe_quant_config
from vllm.model_executor.layers.fused_moe.fused_moe import fused_experts


ROOT = Path("/opt/lvllmds4-x/sm89-tuning/nvcomp-test")
COMPRESSED_ROOT = ROOT / "compressed/layer24-g16"
REFERENCE = ROOT / "layer24-fp8-g16.safetensors"
GROUP = 16
NUM_GROUPS = 256 // GROUP


def load_bytes(path: Path):
    size = path.stat().st_size
    tensor = torch.from_file(str(path), shared=False, size=size, dtype=torch.uint8)
    return tensor


def register(tensor):
    result = torch.cuda.cudart().cudaHostRegister(
        tensor.data_ptr(), tensor.numel() * tensor.element_size(), 0)
    code = result[0] if isinstance(result, tuple) else result
    if code != 0:
        raise RuntimeError(f"cudaHostRegister failed: {code}")


def make_views(storage):
    cursor = 0
    result = {}
    specs = (
        ("w13_weight", (GROUP, 4096, 4096), torch.float8_e4m3fn),
        ("w2_weight", (GROUP, 4096, 2048), torch.float8_e4m3fn),
        ("w13_weight_scale", (GROUP, 32, 32), torch.float32),
        ("w2_weight_scale", (GROUP, 32, 16), torch.float32),
    )
    for name, shape, dtype in specs:
        count = 1
        for dim in shape:
            count *= dim
        byte_count = count * torch.empty((), dtype=dtype).element_size()
        result[name] = storage[cursor:cursor + byte_count].view(dtype).view(shape)
        cursor += byte_count
    assert cursor == storage.numel()
    return result


def stats(output, reference):
    output = output.float()
    reference = reference.float()
    diff = output - reference
    return {
        "max_abs": diff.abs().max().item(),
        "mae": diff.abs().mean().item(),
        "nrmse": (diff.square().mean().sqrt() /
                  reference.square().mean().sqrt()).item(),
        "cosine": torch.nn.functional.cosine_similarity(
            output.flatten(), reference.flatten(), dim=0).item(),
    }


def main():
    torch.manual_seed(20260815)
    lib = ctypes.CDLL(str(ROOT / "libnvcomp_torch_bridge.so"))
    lib.nvcomp_bridge_create.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                                         ctypes.c_uint64]
    lib.nvcomp_bridge_create.restype = ctypes.c_void_p
    lib.nvcomp_bridge_output_size.argtypes = [ctypes.c_void_p]
    lib.nvcomp_bridge_output_size.restype = ctypes.c_size_t
    lib.nvcomp_bridge_decode.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                         ctypes.c_size_t, ctypes.c_void_p]
    lib.nvcomp_bridge_decode.restype = ctypes.c_int
    lib.nvcomp_bridge_destroy.argtypes = [ctypes.c_void_p]
    lib.nvcomp_bridge_error.restype = ctypes.c_char_p

    compressed = [load_bytes(COMPRESSED_ROOT / f"group{i}.ans")
                  for i in range(NUM_GROUPS)]
    for tensor in compressed:
        register(tensor)
    largest = max(range(NUM_GROUPS), key=lambda i: compressed[i].numel())
    stream = torch.cuda.current_stream()
    context = lib.nvcomp_bridge_create(
        compressed[largest].data_ptr(), compressed[largest].numel(),
        stream.cuda_stream)
    if not context:
        raise RuntimeError(lib.nvcomp_bridge_error().decode())

    arena_bytes = 402751488
    arena = torch.empty(arena_bytes, device="cuda", dtype=torch.uint8)
    if lib.nvcomp_bridge_output_size(context) != arena_bytes:
        raise RuntimeError("wrong nvCOMP output size")
    stage = make_views(arena)
    quant = fp8_w8a8_moe_quant_config(
        stage["w13_weight_scale"], stage["w2_weight_scale"],
        block_shape=[128, 128], gemm1_clamp_limit=10.0)
    arena_b = torch.empty(arena_bytes, device="cuda", dtype=torch.uint8)
    stage_b = make_views(arena_b)
    quant_b = fp8_w8a8_moe_quant_config(
        stage_b["w13_weight_scale"], stage_b["w2_weight_scale"],
        block_shape=[128, 128], gemm1_clamp_limit=10.0)
    maps = []
    for begin in range(0, 256, GROUP):
        expert_map = torch.full((256,), -1, device="cuda", dtype=torch.int32)
        expert_map[begin:begin + GROUP] = torch.arange(
            GROUP, device="cuda", dtype=torch.int32)
        maps.append(expert_map)

    fp8_cpu = load_file(REFERENCE, device="cpu")
    # Verify that reusing the manager/config across same-shaped compressed groups
    # still reconstructs each group's exact bitstream.
    exact_groups = []
    for group in range(NUM_GROUPS):
        rc = lib.nvcomp_bridge_decode(
            context, compressed[group].data_ptr(), compressed[group].numel(),
            arena.data_ptr())
        if rc:
            raise RuntimeError(lib.nvcomp_bridge_error().decode())
        torch.cuda.synchronize()
        expected = torch.cat([
            fp8_cpu[name][group * GROUP:(group + 1) * GROUP]
            .contiguous().view(torch.uint8).flatten()
            for name in ("w13_weight", "w2_weight", "w13_weight_scale",
                         "w2_weight_scale")
        ])
        exact_groups.append(torch.equal(arena.cpu(), expected))
    if not all(exact_groups):
        raise RuntimeError(f"group decode mismatch: {exact_groups}")

    def inputs(tokens):
        hidden = torch.randn((tokens, 4096), device="cuda", dtype=torch.bfloat16)
        base = torch.arange(tokens * 6, device="cuda", dtype=torch.int64)
        ids = ((base * 131 + 17) % 256).view(tokens, 6)
        weights = torch.rand((tokens, 6), device="cuda", dtype=torch.float32)
        weights /= weights.sum(dim=1, keepdim=True)
        return hidden, ids, weights

    quality_input = inputs(256)
    full = {name: tensor.cuda() for name, tensor in fp8_cpu.items()}
    full_quant = fp8_w8a8_moe_quant_config(
        full["w13_weight_scale"], full["w2_weight_scale"],
        block_shape=[128, 128], gemm1_clamp_limit=10.0)
    reference = fused_experts(
        quality_input[0], full["w13_weight"], full["w2_weight"],
        quality_input[2], quality_input[1], global_num_experts=256,
        quant_config=full_quant)
    torch.cuda.synchronize()
    del full, full_quant
    gc.collect()
    torch.cuda.empty_cache()

    def compressed_run(hidden, ids, weights):
        output = torch.zeros_like(hidden)
        for group in range(NUM_GROUPS):
            rc = lib.nvcomp_bridge_decode(
                context, compressed[group].data_ptr(), compressed[group].numel(),
                arena.data_ptr())
            if rc:
                raise RuntimeError(lib.nvcomp_bridge_error().decode())
            partial = fused_experts(
                hidden, stage["w13_weight"], stage["w2_weight"], weights, ids,
                global_num_experts=256, expert_map=maps[group],
                quant_config=quant)
            output.add_(partial)
        return output

    quality = compressed_run(*quality_input)
    torch.cuda.synchronize()
    quality_stats = stats(quality, reference)

    transfer_stream = torch.cuda.Stream()
    overlap_context = lib.nvcomp_bridge_create(
        compressed[largest].data_ptr(), compressed[largest].numel(),
        transfer_stream.cuda_stream)
    if not overlap_context:
        raise RuntimeError(lib.nvcomp_bridge_error().decode())
    stages = (stage, stage_b)
    quants = (quant, quant_b)
    ready = (torch.cuda.Event(), torch.cuda.Event())
    consumed = (torch.cuda.Event(), torch.cuda.Event())

    def overlap_run(hidden, ids, weights):
        compute_stream = torch.cuda.current_stream()
        output = torch.zeros_like(hidden)
        with torch.cuda.stream(transfer_stream):
            rc = lib.nvcomp_bridge_decode(
                overlap_context, compressed[0].data_ptr(), compressed[0].numel(),
                arena.data_ptr())
            if rc:
                raise RuntimeError(lib.nvcomp_bridge_error().decode())
            ready[0].record(transfer_stream)
        for group in range(NUM_GROUPS):
            slot = group & 1
            compute_stream.wait_event(ready[slot])
            if group + 1 < NUM_GROUPS:
                next_slot = (group + 1) & 1
                with torch.cuda.stream(transfer_stream):
                    if group + 1 >= 2:
                        transfer_stream.wait_event(consumed[next_slot])
                    rc = lib.nvcomp_bridge_decode(
                        overlap_context, compressed[group + 1].data_ptr(),
                        compressed[group + 1].numel(),
                        (arena, arena_b)[next_slot].data_ptr())
                    if rc:
                        raise RuntimeError(lib.nvcomp_bridge_error().decode())
                    ready[next_slot].record(transfer_stream)
            current = stages[slot]
            partial = fused_experts(
                hidden, current["w13_weight"], current["w2_weight"],
                weights, ids, global_num_experts=256,
                expert_map=maps[group], quant_config=quants[slot])
            output.add_(partial)
            consumed[slot].record(compute_stream)
        return output

    perf_input = inputs(16384)
    warmup = overlap_run(*perf_input)
    torch.cuda.synchronize()
    del warmup
    times = []
    for _ in range(5):
        start = torch.cuda.Event(enable_timing=True)
        end = torch.cuda.Event(enable_timing=True)
        start.record()
        output = overlap_run(*perf_input)
        end.record()
        end.synchronize()
        times.append(start.elapsed_time(end))
        del output

    result = {
        "codec": "ANS",
        "experts_per_batch": GROUP,
        "chunk_tokens": 16384,
        "compressed_bytes_total": sum(x.numel() for x in compressed),
        "uncompressed_bytes_total": arena_bytes * NUM_GROUPS,
        "compressed_fraction": (sum(x.numel() for x in compressed) /
                                (arena_bytes * NUM_GROUPS)),
        "median_ms": statistics.median(times),
        "runs_ms": times,
        "quality": quality_stats,
        "all_groups_bit_exact": all(exact_groups),
        "pipeline": "double_arena_overlap",
        "persistent_gpu_bytes": 2 * arena_bytes + compressed[largest].numel(),
    }
    print(json.dumps(result), flush=True)
    lib.nvcomp_bridge_destroy(context)
    lib.nvcomp_bridge_destroy(overlap_context)
    for tensor in compressed:
        torch.cuda.cudart().cudaHostUnregister(tensor.data_ptr())


if __name__ == "__main__":
    main()
