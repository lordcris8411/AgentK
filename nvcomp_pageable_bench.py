#!/usr/bin/env python3
import ctypes
import json
import statistics
import time
from pathlib import Path

import torch


ROOT = Path("/opt/lvllmds4-x/sm89-tuning/nvcomp-test")
files = sorted((ROOT / "compressed/layer24").glob("group*.ans"),
               key=lambda path: int(path.stem[5:]))
compressed = [torch.from_file(str(path), shared=False, size=path.stat().st_size,
                              dtype=torch.uint8) for path in files]

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


def run(pinned):
    source = compressed
    registered = []
    if pinned:
        for tensor in source:
            result = torch.cuda.cudart().cudaHostRegister(
                tensor.data_ptr(), tensor.numel(), 0)
            code = result[0] if isinstance(result, tuple) else result
            if code != 0:
                raise RuntimeError(f"register failed: {code}")
            registered.append(tensor)
    stream = torch.cuda.Stream()
    largest = max(source, key=lambda tensor: tensor.numel())
    context = lib.nvcomp_bridge_create(
        largest.data_ptr(), largest.numel(), stream.cuda_stream)
    if not context:
        raise RuntimeError(lib.nvcomp_bridge_error().decode())
    arena = torch.empty(lib.nvcomp_bridge_output_size(context), dtype=torch.uint8,
                        device="cuda")
    times = []
    for _ in range(5):
        start = time.perf_counter()
        for tensor in source:
            if lib.nvcomp_bridge_decode(context, tensor.data_ptr(), tensor.numel(),
                                        arena.data_ptr()):
                raise RuntimeError(lib.nvcomp_bridge_error().decode())
        stream.synchronize()
        times.append((time.perf_counter() - start) * 1000)
    lib.nvcomp_bridge_destroy(context)
    for tensor in registered:
        torch.cuda.cudart().cudaHostUnregister(tensor.data_ptr())
    return times


result = {kind: run(kind == "pinned") for kind in ("pageable", "pinned")}
result["median_ms"] = {kind: statistics.median(times)
                       for kind, times in result.items()}
print(json.dumps(result))
