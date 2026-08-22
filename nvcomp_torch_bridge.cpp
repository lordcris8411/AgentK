#include <cuda_runtime.h>
#include <nvcomp/nvcompManagerFactory.hpp>

#include <cstdint>
#include <memory>
#include <string>

using namespace nvcomp;

struct DecodeContext {
  uint8_t* device_compressed = nullptr;
  size_t capacity = 0;
  size_t output_size = 0;
  cudaStream_t stream = nullptr;
  std::shared_ptr<nvcompManagerBase> manager;
  DecompressionConfig config;
};

static thread_local std::string last_error;

extern "C" const char* nvcomp_bridge_error() { return last_error.c_str(); }

static void* create_context(
    const uint8_t* host_compressed, size_t compressed_bytes, size_t capacity,
    uintptr_t stream_value) {
  try {
    auto* context = new DecodeContext();
    context->stream = reinterpret_cast<cudaStream_t>(stream_value);
    if (capacity < compressed_bytes)
      throw std::runtime_error("capacity is smaller than initial input");
    context->capacity = capacity;
    cudaError_t status = cudaMalloc(&context->device_compressed, capacity);
    if (status != cudaSuccess) throw std::runtime_error(cudaGetErrorString(status));
    status = cudaMemcpyAsync(context->device_compressed, host_compressed,
                             compressed_bytes, cudaMemcpyHostToDevice,
                             context->stream);
    if (status != cudaSuccess) throw std::runtime_error(cudaGetErrorString(status));
    status = cudaStreamSynchronize(context->stream);
    if (status != cudaSuccess) throw std::runtime_error(cudaGetErrorString(status));
    context->manager = create_manager(context->device_compressed, context->stream,
                                      NoComputeNoVerify);
    context->config = context->manager->configure_decompression(
        context->device_compressed);
    context->output_size = context->config.decomp_data_size;
    return context;
  } catch (const std::exception& error) {
    last_error = error.what();
    return nullptr;
  }
}

extern "C" void* nvcomp_bridge_create(
    const uint8_t* host_compressed, size_t compressed_bytes,
    uintptr_t stream_value) {
  return create_context(host_compressed, compressed_bytes, compressed_bytes,
                        stream_value);
}

extern "C" void* nvcomp_bridge_create_capacity(
    const uint8_t* host_compressed, size_t compressed_bytes, size_t capacity,
    uintptr_t stream_value) {
  return create_context(host_compressed, compressed_bytes, capacity,
                        stream_value);
}

extern "C" size_t nvcomp_bridge_output_size(void* opaque) {
  return static_cast<DecodeContext*>(opaque)->output_size;
}

extern "C" int nvcomp_bridge_decode(
    void* opaque, const uint8_t* host_compressed, size_t compressed_bytes,
    uint8_t* device_output) {
  try {
    auto* context = static_cast<DecodeContext*>(opaque);
    if (compressed_bytes > context->capacity)
      throw std::runtime_error("compressed input exceeds context capacity");
    cudaError_t status = cudaMemcpyAsync(
        context->device_compressed, host_compressed, compressed_bytes,
        cudaMemcpyHostToDevice, context->stream);
    if (status != cudaSuccess) throw std::runtime_error(cudaGetErrorString(status));
    context->manager->decompress(device_output, context->device_compressed,
                                 context->config);
    return 0;
  } catch (const std::exception& error) {
    last_error = error.what();
    return -1;
  }
}

extern "C" void nvcomp_bridge_destroy(void* opaque) {
  auto* context = static_cast<DecodeContext*>(opaque);
  if (context == nullptr) return;
  cudaStreamSynchronize(context->stream);
  context->manager.reset();
  cudaFree(context->device_compressed);
  delete context;
}
