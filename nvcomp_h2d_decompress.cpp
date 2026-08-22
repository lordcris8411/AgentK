#include <cuda_runtime.h>
#include <nvcomp/nvcompManagerFactory.hpp>

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <memory>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>

#define CUDA_OK(call) do { \
  cudaError_t status = (call); \
  if (status != cudaSuccess) throw std::runtime_error(cudaGetErrorString(status)); \
} while (0)

using namespace nvcomp;

static std::vector<uint8_t> read_file(const std::string& path) {
  std::ifstream stream(path, std::ios::binary | std::ios::ate);
  if (!stream) throw std::runtime_error("cannot open input file");
  auto size = static_cast<size_t>(stream.tellg());
  std::vector<uint8_t> data(size);
  stream.seekg(0);
  stream.read(reinterpret_cast<char*>(data.data()), size);
  if (!stream) throw std::runtime_error("cannot read input file");
  return data;
}

static float event_ms(cudaEvent_t start, cudaEvent_t end) {
  float result = 0;
  CUDA_OK(cudaEventElapsedTime(&result, start, end));
  return result;
}

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cerr << "usage: nvcomp_h2d_decompress <ans|gdeflate|lz4> <file> [runs]\n";
    return 2;
  }
  const std::string codec = argv[1];
  const std::string path = argv[2];
  const int runs = argc > 3 ? std::stoi(argv[3]) : 10;
  const std::string compressed_output = argc > 4 ? argv[4] : "";
  auto input = read_file(path);

  cudaStream_t stream;
  CUDA_OK(cudaStreamCreate(&stream));
  std::shared_ptr<nvcompManagerBase> manager;
  constexpr size_t chunk = 1 << 16;
  if (codec == "ans") {
    manager = std::make_shared<ANSManager>(
        chunk,
        nvcompBatchedANSCompressOpts_t{nvcomp_rANS, NVCOMP_TYPE_CHAR, {0}},
        nvcompBatchedANSDecompressDefaultOpts, stream, NoComputeNoVerify);
  } else if (codec == "gdeflate") {
    manager = std::make_shared<GdeflateManager>(
        chunk, nvcompBatchedGdeflateCompressOpts_t{0, {0}},
        nvcompBatchedGdeflateDecompressDefaultOpts, stream, NoComputeNoVerify);
  } else if (codec == "lz4") {
    manager = std::make_shared<LZ4Manager>(
        chunk,
        nvcompBatchedLZ4CompressOpts_t{NVCOMP_TYPE_CHAR,
                                      NVCOMP_BITSHUFFLE_NONE, {0}},
        nvcompBatchedLZ4DecompressDefaultOpts, stream, NoComputeNoVerify);
  } else {
    throw std::runtime_error("unknown codec");
  }

  uint8_t *d_input = nullptr, *d_compressed = nullptr, *d_output = nullptr;
  uint8_t* h_compressed = nullptr;
  CUDA_OK(cudaMalloc(&d_input, input.size()));
  CUDA_OK(cudaMemcpy(d_input, input.data(), input.size(), cudaMemcpyHostToDevice));
  auto compression = manager->configure_compression(input.size());
  CUDA_OK(cudaMalloc(&d_compressed, compression.max_compressed_buffer_size));
  manager->compress(d_input, d_compressed, compression);
  CUDA_OK(cudaStreamSynchronize(stream));
  const size_t compressed_bytes = manager->get_compressed_output_size(d_compressed);
  CUDA_OK(cudaHostAlloc(&h_compressed, compressed_bytes, cudaHostAllocDefault));
  CUDA_OK(cudaMemcpy(h_compressed, d_compressed, compressed_bytes,
                     cudaMemcpyDeviceToHost));
  if (!compressed_output.empty()) {
    std::ofstream output_stream(compressed_output, std::ios::binary);
    output_stream.write(reinterpret_cast<const char*>(h_compressed),
                        compressed_bytes);
    if (!output_stream) throw std::runtime_error("cannot write compressed output");
  }
  CUDA_OK(cudaFree(d_input));

  auto decompression = manager->configure_decompression(d_compressed);
  if (decompression.decomp_data_size != input.size())
    throw std::runtime_error("unexpected decompressed size");
  CUDA_OK(cudaMalloc(&d_output, input.size()));

  for (int i = 0; i < 2; ++i) {
    CUDA_OK(cudaMemcpyAsync(d_compressed, h_compressed, compressed_bytes,
                            cudaMemcpyHostToDevice, stream));
    manager->decompress(d_output, d_compressed, decompression);
  }
  CUDA_OK(cudaStreamSynchronize(stream));

  cudaEvent_t start, after_copy, end;
  CUDA_OK(cudaEventCreate(&start));
  CUDA_OK(cudaEventCreate(&after_copy));
  CUDA_OK(cudaEventCreate(&end));
  std::vector<float> copy_times, decode_times, total_times;
  for (int i = 0; i < runs; ++i) {
    CUDA_OK(cudaEventRecord(start, stream));
    CUDA_OK(cudaMemcpyAsync(d_compressed, h_compressed, compressed_bytes,
                            cudaMemcpyHostToDevice, stream));
    CUDA_OK(cudaEventRecord(after_copy, stream));
    manager->decompress(d_output, d_compressed, decompression);
    CUDA_OK(cudaEventRecord(end, stream));
    CUDA_OK(cudaEventSynchronize(end));
    copy_times.push_back(event_ms(start, after_copy));
    decode_times.push_back(event_ms(after_copy, end));
    total_times.push_back(event_ms(start, end));
  }

  std::vector<uint8_t> output(input.size());
  CUDA_OK(cudaMemcpy(output.data(), d_output, output.size(), cudaMemcpyDeviceToHost));
  if (output != input) throw std::runtime_error("validation failed");

  auto median = [](std::vector<float> values) {
    std::sort(values.begin(), values.end());
    return values[values.size() / 2];
  };
  std::cout << "{\"codec\":\"" << codec << "\","
            << "\"uncompressed_bytes\":" << input.size() << ","
            << "\"compressed_bytes\":" << compressed_bytes << ","
            << "\"compressed_fraction\":"
            << static_cast<double>(compressed_bytes) / input.size() << ","
            << "\"h2d_median_ms\":" << median(copy_times) << ","
            << "\"decode_median_ms\":" << median(decode_times) << ","
            << "\"h2d_decode_median_ms\":" << median(total_times) << ","
            << "\"runs\":" << runs << ",\"validated\":true}" << std::endl;

  CUDA_OK(cudaEventDestroy(start));
  CUDA_OK(cudaEventDestroy(after_copy));
  CUDA_OK(cudaEventDestroy(end));
  CUDA_OK(cudaFree(d_compressed));
  CUDA_OK(cudaFree(d_output));
  CUDA_OK(cudaFreeHost(h_compressed));
  manager.reset();
  CUDA_OK(cudaStreamDestroy(stream));
  return 0;
}
