#!/usr/bin/env python3
import json
import argparse
import time
import urllib.request


parser = argparse.ArgumentParser()
parser.add_argument("--tokens", type=int, default=16384)
parser.add_argument("--max-tokens", type=int, default=1)
parser.add_argument("--word", default="test")
args = parser.parse_args()

payload = json.dumps({
    "model": "DeepSeek-V4-Flash-0731",
    "prompt": f" {args.word}" * args.tokens,
    "max_tokens": args.max_tokens,
    "temperature": 0,
}).encode()
request = urllib.request.Request(
    "http://127.0.0.1:8070/v1/completions",
    data=payload,
    headers={"Content-Type": "application/json"},
)
started = time.perf_counter()
with urllib.request.urlopen(request, timeout=180) as response:
    result = json.load(response)
elapsed = time.perf_counter() - started
print(json.dumps({
    "wall_seconds": elapsed,
    "usage": result.get("usage"),
    "text": result["choices"][0]["text"],
}, ensure_ascii=False))
