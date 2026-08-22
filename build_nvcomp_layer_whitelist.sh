#!/usr/bin/env bash
set -euo pipefail

test_root=/opt/lvllmds4-x/sm89-tuning/nvcomp-test
layers=(11 12 13 14 15 16 17 18 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40)

build_layer() {
    layer="$1"
    compressed_dir="$test_root/compressed/layer$layer"
    if [[ $(find "$compressed_dir" -maxdepth 1 -name 'group*.ans' 2>/dev/null | wc -l) -eq 16 ]]; then
        echo "layer=$layer status=already_complete"
        return
    fi
    raw_dir="$test_root/raw/layer$layer-g16"
    reference="$test_root/layer$layer-fp8-g16.safetensors"
    rm -rf "$raw_dir" "$compressed_dir"
    mkdir -p "$raw_dir" "$compressed_dir"
    "$test_root/../../venv/bin/python" "$test_root/nvcomp_fp8_layer_test.py" \
        --layer "$layer" --output "$reference" \
        --raw-group-dir "$raw_dir" --group-size 16 \
        >"$test_root/build-layer$layer.log" 2>&1
    for group in $(seq 0 15); do
        "$test_root/nvcomp_h2d_decompress" ans \
            "$raw_dir/group$group.raw" 2 \
            "$compressed_dir/group$group.ans" \
            >>"$test_root/build-layer$layer.log" 2>&1
    done
    rm -rf "$raw_dir"
    rm -f "$reference"
    echo "layer=$layer status=complete bytes=$(du -sb "$compressed_dir" | cut -f1)"
}

export test_root
export -f build_layer
printf '%s\n' "${layers[@]}" | xargs -n 1 -P 3 bash -c 'build_layer "$1"' _
