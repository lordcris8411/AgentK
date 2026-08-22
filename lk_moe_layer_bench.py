#!/usr/bin/env python3
import json
import statistics
from pathlib import Path

import torch
from safetensors import safe_open


FP4_LUT = torch.tensor([
    0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0,
    -0.0, -0.5, -1.0, -1.5, -2.0, -3.0, -4.0, -6.0,
], dtype=torch.float32)


class Checkpoint:
    def __init__(self, model_dir):
        self.model_dir = Path(model_dir)
        self.weight_map = json.loads(
            (self.model_dir / "model.safetensors.index.json").read_text()
        )["weight_map"]

    def get(self, name):
        with safe_open(self.model_dir / self.weight_map[name],
                       framework="pt", device="cpu") as handle:
            return handle.get_tensor(name)


def names(layer, expert, projection):
    base = f"layers.{layer}.ffn.experts.{expert}.{projection}"
    return f"{base}.weight", f"{base}.scale"


def load_layer(layer=3):
    checkpoint = Checkpoint("/root/DeepSeek-V4-Flash-0731")
    w13 = torch.empty((256, 4096, 2048), dtype=torch.uint8)
    w2 = torch.empty((256, 4096, 1024), dtype=torch.uint8)
    s13 = torch.empty((256, 4096, 128), dtype=torch.uint8)
    s2 = torch.empty((256, 4096, 64), dtype=torch.uint8)
    for expert in range(256):
        w1n, s1n = names(layer, expert, "w1")
        w3n, s3n = names(layer, expert, "w3")
        w2n, s2n = names(layer, expert, "w2")
        w13[expert, :2048].copy_(checkpoint.get(w1n).view(torch.uint8))
        w13[expert, 2048:].copy_(checkpoint.get(w3n).view(torch.uint8))
        w2[expert].copy_(checkpoint.get(w2n).view(torch.uint8))
        s13[expert, :2048].copy_(checkpoint.get(s1n).view(torch.uint8))
        s13[expert, 2048:].copy_(checkpoint.get(s3n).view(torch.uint8))
        s2[expert].copy_(checkpoint.get(s2n).view(torch.uint8))
    return w13.contiguous(), w2.contiguous(), s13.contiguous(), s2.contiguous()


def main():
    import lk_moe

    weights = load_layer()
    cudart = torch.cuda.cudart()
    for tensor in weights:
        result = cudart.cudaHostRegister(
            tensor.data_ptr(), tensor.numel() * tensor.element_size(), 0)
        code = result[0] if isinstance(result, tuple) else result
        if code != 0:
            raise RuntimeError(f"cudaHostRegister failed: {code}")
    config = lk_moe.MOEConfigV2()
    config.num_processes = 1
    config.process_id = 0
    config.gpu_id = 0
    config.has_gate_proj = True
    config.expert_num = 256
    config.top_k = 6
    config.hidden_size = 4096
    config.intermediate_size = 2048
    config.max_batch_size = 16384
    config.max_num_seqs = 6
    config.stride = 32
    config.group_min_len = 10
    # Standalone gpu_prefill receives the entire 16K batch in one call.
    config.group_max_len = 16512
    config.groupN = 1
    config.groupK = 32
    config.activation_type = 0
    config.swiglu_limit = 10.0
    moe = lk_moe.MOE_MXFP4(
        config, *(tensor.data_ptr() for tensor in weights), 0, 0)

    torch.manual_seed(20260815)
    hidden = torch.randn((16384, 4096), device="cuda", dtype=torch.bfloat16)
    base = torch.arange(16384 * 6, device="cuda", dtype=torch.int64)
    ids = ((base * 131 + 17) % 256).view(16384, 6).to(torch.int32)
    routing = torch.rand((16384, 6), device="cuda", dtype=torch.float32)
    routing /= routing.sum(dim=1, keepdim=True)
    output = torch.empty_like(hidden)

    def run():
        moe.gpu_prefill(
            hidden.data_ptr(), output.data_ptr(), ids.data_ptr(),
            routing.data_ptr(), hidden.size(0), ids.size(1),
            torch.cuda.current_stream().cuda_stream)

    run()
    torch.cuda.synchronize()
    times = []
    for _ in range(5):
        start = torch.cuda.Event(enable_timing=True)
        end = torch.cuda.Event(enable_timing=True)
        start.record()
        run()
        end.record()
        end.synchronize()
        times.append(start.elapsed_time(end))
    print(json.dumps({"path": "lk_moe_mxfp4", "chunk_tokens": 16384,
                      "median_ms": statistics.median(times),
                      "runs_ms": times}), flush=True)


if __name__ == "__main__":
    main()
