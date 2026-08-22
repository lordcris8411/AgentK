#!/usr/bin/env python3
import argparse
import json
import time
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file


FP4_LUT = torch.tensor([
    0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0,
    -0.0, -0.5, -1.0, -1.5, -2.0, -3.0, -4.0, -6.0,
], dtype=torch.float32)


class Checkpoint:
    def __init__(self, model_dir: Path):
        self.model_dir = model_dir
        index = model_dir / "model.safetensors.index.json"
        self.weight_map = json.loads(index.read_text())["weight_map"]

    def get(self, name: str) -> torch.Tensor:
        with safe_open(self.model_dir / self.weight_map[name],
                       framework="pt", device="cpu") as handle:
            return handle.get_tensor(name)


def dequant_mxfp4(packed: torch.Tensor, scale: torch.Tensor) -> torch.Tensor:
    raw = packed.contiguous().view(torch.uint8)
    low = FP4_LUT[(raw & 0x0f).long()]
    high = FP4_LUT[((raw >> 4) & 0x0f).long()]
    values = torch.stack((low, high), dim=-1).flatten(-2)
    scale_raw = scale.contiguous().view(torch.uint8).to(torch.int16)
    scales = torch.exp2(scale_raw.float() - 127.0).repeat_interleave(32, dim=-1)
    return values * scales


def quant_fp8(x: torch.Tensor):
    rows, cols = x.shape
    tiles = x.reshape(rows // 128, 128, cols // 128, 128)
    scale = torch.clamp(
        tiles.abs().amax(dim=(1, 3)) / 448.0,
        min=torch.finfo(torch.float32).tiny,
    )
    expanded = scale.repeat_interleave(128, 0).repeat_interleave(128, 1)
    quant = torch.clamp(x / expanded, -448.0, 448.0).to(torch.float8_e4m3fn)
    return quant.contiguous(), scale.contiguous()


def names(layer: int, expert: int, projection: str):
    base = f"layers.{layer}.ffn.experts.{expert}.{projection}"
    return f"{base}.weight", f"{base}.scale"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path,
                        default=Path("/root/DeepSeek-V4-Flash-0731"))
    parser.add_argument("--layer", type=int, default=3)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--raw-group-dir", type=Path)
    parser.add_argument("--group-size", type=int, default=32)
    args = parser.parse_args()

    checkpoint = Checkpoint(args.model)
    w13 = torch.empty((256, 4096, 4096), dtype=torch.float8_e4m3fn)
    w2 = torch.empty((256, 4096, 2048), dtype=torch.float8_e4m3fn)
    s13 = torch.empty((256, 32, 32), dtype=torch.float32)
    s2 = torch.empty((256, 32, 16), dtype=torch.float32)
    started = time.perf_counter()
    for expert in range(256):
        converted = {}
        for projection in ("w1", "w3", "w2"):
            weight_name, scale_name = names(args.layer, expert, projection)
            converted[projection] = dequant_mxfp4(
                checkpoint.get(weight_name), checkpoint.get(scale_name))
        q13, qs13 = quant_fp8(torch.cat((converted["w1"], converted["w3"])))
        q2, qs2 = quant_fp8(converted["w2"])
        w13[expert].copy_(q13)
        w2[expert].copy_(q2)
        s13[expert].copy_(qs13)
        s2[expert].copy_(qs2)
        if (expert + 1) % 32 == 0:
            print(f"converted={expert + 1}/256 elapsed={time.perf_counter()-started:.1f}s",
                  flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    save_file({"w13_weight": w13, "w2_weight": w2,
               "w13_weight_scale": s13, "w2_weight_scale": s2},
              args.output,
              metadata={"layer": str(args.layer), "format": "fp8-e4m3fn-block128"})
    print(f"saved={args.output} bytes={args.output.stat().st_size}", flush=True)
    if args.raw_group_dir:
        if 256 % args.group_size:
            raise ValueError("group size must divide 256")
        args.raw_group_dir.mkdir(parents=True, exist_ok=True)
        tensors = (w13, w2, s13, s2)
        for group, begin in enumerate(range(0, 256, args.group_size)):
            path = args.raw_group_dir / f"group{group}.raw"
            with path.open("wb") as handle:
                for tensor in tensors:
                    handle.write(tensor[begin:begin + args.group_size]
                                 .contiguous().view(torch.uint8).numpy().tobytes())
            print(f"raw_group={group} bytes={path.stat().st_size}", flush=True)


if __name__ == "__main__":
    main()
