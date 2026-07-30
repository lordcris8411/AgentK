import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { freemem, totalmem } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import extractZip from "extract-zip";
import type { JsonObject } from "./types.js";
import { asArray, asObject, asString, atomicWrite, errorMessage, isPathInside, piAgentDirectory, randomId, readJson } from "./utils.js";

export const LOCAL_MODEL_PROVIDER_ID = "agent-k-llama-cpp";
export const LLAMA_CPP_BUILD = "b10182";
const MAX_LOG_LINES = 3_000;
const VERIFY_TIMEOUT_MS = 90_000;

export type LocalModelSource = "huggingface" | "modelscope" | "import";
export type LocalModelBackend = "auto" | "cpu" | "vulkan" | "rocm" | "cuda12" | "cuda13";
export type LocalModelKvCacheType = "f32" | "f16" | "bf16" | "q8_0" | "q4_0" | "q4_1" | "iq4_nl" | "q5_0" | "q5_1";
export type LocalModelCompatibility = "unverified" | "verifying-tools" | "tool-compatible" | "tool-incompatible";
export type LocalModelStatus = "queued" | "downloading" | "paused" | "verifying-download" | "ready" | "provisioning" | "loading" | "verifying-tools" | "running" | "stopping" | "failed" | "missing";

export interface LocalModelRuntimeConfig {
  backend: LocalModelBackend;
  contextSize: number;
  gpuLayers: number;
  threads: number;
  cacheTypeK: LocalModelKvCacheType;
  cacheTypeV: LocalModelKvCacheType;
  maxOutputTokens: number;
  reasoning: boolean;
}

export function applyLocalModelReasoningPolicy(body: JsonObject, reasoningEnabled: boolean): JsonObject {
  if (reasoningEnabled) return body;
  return {
    ...body,
    chat_template_kwargs: {
      ...asObject(body.chat_template_kwargs),
      enable_thinking: false,
      preserve_thinking: false,
    },
  };
}

export interface LocalModelRecord {
  id: string;
  name: string;
  source: LocalModelSource;
  repository?: string;
  revision?: string;
  files: Array<{ name: string; path: string; size: number; sha256: string }>;
  size: number;
  sha256: string;
  architecture?: string;
  quantization?: string;
  parameterCount?: number;
  trainingContext?: number;
  blockCount?: number;
  compatibility: LocalModelCompatibility;
  compatibilityKey?: string;
  compatibilityError?: string;
  verifiedAt?: number;
  config: LocalModelRuntimeConfig;
  status: LocalModelStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LocalModelDownloadTask {
  id: string;
  source: Exclude<LocalModelSource, "import">;
  repository: string;
  revision: string;
  files: Array<{ name: string; url: string; size: number; sha256?: string; etag?: string }>;
  completedBytes: number;
  totalBytes: number;
  bytesPerSecond?: number;
  status: "queued" | "downloading" | "paused" | "verifying-download" | "failed";
  error?: string;
  createdAt: number;
  updatedAt: number;
}

interface LocalModelRegistry {
  version: 1;
  activeModelId?: string;
  models: LocalModelRecord[];
  downloads: LocalModelDownloadTask[];
}

export interface HubModelResult {
  source: Exclude<LocalModelSource, "import">;
  repository: string;
  name: string;
  description?: string;
  downloads?: number;
  gated: boolean;
  private: boolean;
}

export interface HubGgufFile {
  name: string;
  size: number;
  sha256?: string;
  group: string;
  shardIndex: number;
  shardCount: number;
}

export interface LocalModelManagerSnapshot {
  activeModelId?: string;
  runningModelId?: string;
  models: LocalModelRecord[];
  downloads: LocalModelDownloadTask[];
  hardware: HardwareInfo;
  proxyUrl: string;
  storagePath: string;
  defaultStoragePath: string;
  piBusy: boolean;
  runtimeDownload?: RuntimeDownloadProgress;
  verificationStage?: LocalModelVerificationStage;
  providerConflict?: string;
}

export interface LocalModelVerificationStage {
  modelId: string;
  phase: "preparing-runtime" | "loading-model" | "checking-template" | "requesting-tool-call" | "checking-tool-result";
}

export interface RuntimeDownloadProgress {
  modelId: string;
  backend: Exclude<LocalModelBackend, "auto">;
  source: string;
  fileName: string;
  phase: "downloading" | "verifying" | "extracting";
  completedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
}

type LocalModelRunPhase = "preparing-runtime" | "downloading-runtime" | "verifying-runtime" | "extracting-runtime" | "starting-server" | "loading-model" | "health-check" | "ready";

interface LocalModelRunTransaction {
  id: string;
  modelId: string;
  modelName: string;
}

export interface HardwareInfo {
  platform: NodeJS.Platform;
  architecture: string;
  totalMemory: number;
  availableBackends: LocalModelBackend[];
  gpu?: string;
  vram?: number;
}

type ManagerOptions = {
  cachePath: string;
  rootPath?: string;
  emit(event: JsonObject): void;
  piBusy(): boolean;
  verifyPiBusy?(): Promise<boolean>;
  reloadPi(): Promise<void>;
  migrateModelReferences(previous: string | undefined, next?: string): Promise<void>;
  endpoints?: { huggingface?: string; modelscope?: string; github?: string };
  verificationTimeoutMs?: number;
  runtimeOverride?: { executable: string; args: string[] };
};

type RuntimeAsset = { name: string; sha256: string; repository?: string; source?: string; url?: string; thirdParty?: boolean; companion?: RuntimeAsset };

function runtimeAssetChain(asset: RuntimeAsset): RuntimeAsset[] {
  const assets: RuntimeAsset[] = [];
  for (let current: RuntimeAsset | undefined = asset; current; current = current.companion) assets.push(current);
  return assets;
}

class RuntimeProvisionError extends Error {
  constructor(cause: unknown) {
    super(`Unable to provision the official llama.cpp runtime: ${errorMessage(cause)}`, { cause });
    this.name = "RuntimeProvisionError";
  }
}

export const LLAMA_RUNTIME_ASSETS: Record<string, RuntimeAsset> = {
  "linux-cpu": { name: "llama-b10182-bin-ubuntu-x64.tar.gz", sha256: "9a087d633cc03a8e93f2d689bc80adbfb680efca025bc9a328d5e186d528757a" },
  "linux-cuda12": {
    name: "llama.cpp-b10182-cuda-12.8-amd64.tar.gz", sha256: "5576a132d768b240b1c3e950e71b456cbf7b90c6a38dca2fcd93f965b32098c9", repository: "ai-dock/llama.cpp-cuda", thirdParty: true,
    companion: {
      name: "nvidia_cuda_runtime_cu12-12.8.90-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl", sha256: "adade8dcbd0edf427b7204d480d6066d33902cab2a4707dcfc48a2d0fd44ab90", source: "NVIDIA · PyPI", url: "https://files.pythonhosted.org/packages/0d/9b/a997b638fcd068ad6e4d53b8551a7d30fe8b404d6f1804abf1df69838932/nvidia_cuda_runtime_cu12-12.8.90-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
      companion: {
        name: "nvidia_cublas_cu12-12.8.4.1-py3-none-manylinux_2_27_x86_64.whl", sha256: "8ac4e771d5a348c551b2a426eda6193c19aa630236b418086020df5ba9667142", source: "NVIDIA · PyPI", url: "https://files.pythonhosted.org/packages/dc/61/e24b560ab2e2eaeb3c839129175fb330dfcfc29e5203196e5541a4c44682/nvidia_cublas_cu12-12.8.4.1-py3-none-manylinux_2_27_x86_64.whl",
        companion: { name: "nvidia_nccl_cu12-2.26.2-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl", sha256: "694cf3879a206553cc9d7dbda76b13efaf610fdb70a50cba303de1b0d1530ac6", source: "NVIDIA · PyPI", url: "https://files.pythonhosted.org/packages/67/ca/f42388aed0fddd64ade7493dbba36e1f534d4e6fdbdd355c6a90030ae028/nvidia_nccl_cu12-2.26.2-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl" },
      },
    },
  },
  "linux-vulkan": { name: "llama-b10182-bin-ubuntu-vulkan-x64.tar.gz", sha256: "769a68af6d1042dbbb2865bc0046809e85fd9dc742f38da052f1f31b1121edc7" },
  "linux-rocm": { name: "llama-b10182-bin-ubuntu-rocm-7.2-x64.tar.gz", sha256: "0f292387cfdaad954a8d0ba517be75b3e57ae6992862ef56cc0d2d4ce5689f4b" },
  "win32-cpu": { name: "llama-b10182-bin-win-cpu-x64.zip", sha256: "fc8f8e6c08aa92bafbcc3df4cace42e2722f0fceb5f43867032a979390378b5d" },
  "win32-vulkan": { name: "llama-b10182-bin-win-vulkan-x64.zip", sha256: "79bbba88a4b44c2ba48df98117d5ed8fa525ea8405440fd2e801c702cbefe773" },
  "win32-cuda12": { name: "llama-b10182-bin-win-cuda-12.4-x64.zip", sha256: "5835bbe18c8dcdbcb229a77c625916be4ec6ed378bba33241df41304a305875d", companion: { name: "cudart-llama-bin-win-cuda-12.4-x64.zip", sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6" } },
  "win32-cuda13": { name: "llama-b10182-bin-win-cuda-13.3-x64.zip", sha256: "7913b8346697981071f0e8bd45de6bed22072542b61c086cf4584b2b938a2359", companion: { name: "cudart-llama-bin-win-cuda-13.3-x64.zip", sha256: "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e" } },
};

const DEFAULT_CONFIG: LocalModelRuntimeConfig = {
  backend: "auto",
  contextSize: 32_768,
  gpuLayers: -1,
  threads: 0,
  cacheTypeK: "f16",
  cacheTypeV: "f16",
  maxOutputTokens: 8_192,
  reasoning: false,
};

function safeId(value: string): string {
  const stem = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 80);
  return stem || randomId("model-");
}

function validModelId(value: string): boolean { return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value) && value !== "." && value !== ".."; }

export function parseHubRepository(source: Exclude<LocalModelSource, "import">, input: string): string {
  const value = input.trim().replace(/\/$/, "");
  let candidate = value;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    const expected = source === "huggingface" ? "huggingface.co" : "modelscope.cn";
    if (url.hostname !== expected && url.hostname !== `www.${expected}`) throw new Error(`Only official ${expected} repository URLs are accepted`);
    const parts = url.pathname.split("/").filter(Boolean);
    const modelIndex = source === "modelscope" && parts[0] === "models" ? 1 : 0;
    candidate = parts.slice(modelIndex, modelIndex + 2).join("/");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) throw new Error("Repository must be owner/repo or an official repository URL");
  return candidate;
}

export function parseGgufShard(name: string): { group: string; index: number; count: number } {
  const match = /^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i.exec(name);
  if (!match) return { group: name, index: 1, count: 1 };
  return { group: `${match[1]}.gguf`, index: Number(match[2]), count: Number(match[3]) };
}

export function completeShardGroup(files: HubGgufFile[], selected: string): HubGgufFile[] {
  const picked = files.find((file) => file.name === selected);
  if (!picked) throw new Error("Selected GGUF file was not found");
  const group = files.filter((file) => file.group === picked.group).sort((left, right) => left.shardIndex - right.shardIndex);
  if (group.length !== picked.shardCount || group.some((file, index) => file.shardIndex !== index + 1)) throw new Error("The repository does not contain the complete GGUF shard group");
  return group;
}

function clone<T>(value: T): T { return structuredClone(value); }

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function validateConfig(value: Partial<LocalModelRuntimeConfig>, previous = DEFAULT_CONFIG): LocalModelRuntimeConfig {
  const backend = ["auto", "cpu", "vulkan", "rocm", "cuda12", "cuda13"].includes(String(value.backend)) ? value.backend as LocalModelBackend : previous.backend;
  const cacheTypeK = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"].includes(String(value.cacheTypeK)) ? value.cacheTypeK as LocalModelKvCacheType : previous.cacheTypeK;
  const cacheTypeV = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"].includes(String(value.cacheTypeV)) ? value.cacheTypeV as LocalModelKvCacheType : previous.cacheTypeV;
  const context = boundedInteger(value.contextSize, 512, 1_048_576, previous.contextSize);
  const requestedOutput = boundedInteger(value.maxOutputTokens, 64, 65_536, previous.maxOutputTokens);
  return {
    backend,
    contextSize: context,
    gpuLayers: boundedInteger(value.gpuLayers, -1, 10_000, previous.gpuLayers),
    threads: boundedInteger(value.threads, 0, 512, previous.threads),
    cacheTypeK,
    cacheTypeV,
    maxOutputTokens: Math.min(context, requestedOutput),
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : previous.reasoning,
  };
}

export function selectAutomaticBackend(platform: NodeJS.Platform, available: LocalModelBackend[]): Exclude<LocalModelBackend, "auto"> {
  const preference: Array<Exclude<LocalModelBackend, "auto">> = platform === "win32"
    ? ["cuda13", "cuda12", "vulkan", "cpu"]
    : ["cuda12", "rocm", "vulkan", "cpu"];
  return preference.find((backend) => available.includes(backend)) ?? "cpu";
}

export function resolveGpuLayers(backend: Exclude<LocalModelBackend, "auto">, configured: number): number | "auto" {
  if (backend === "cpu") return 0;
  return configured >= 0 ? configured : "auto";
}

function detectHardware(): HardwareInfo {
  const availableBackends: LocalModelBackend[] = ["auto", "cpu"];
  let gpu: string | undefined;
  let vram: number | undefined;
  if (process.platform === "win32") {
    const vulkan = spawnSync("vulkaninfo", ["--summary"], { encoding: "utf8", windowsHide: true });
    if (vulkan.status === 0) availableBackends.push("vulkan");
    const nvidia = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true });
    if (nvidia.status === 0 && nvidia.stdout.trim()) {
      const [name, memory, driver] = nvidia.stdout.trim().split(/,\s*/);
      gpu = `${name} (${driver})`;
      vram = Number(memory) * 1024 * 1024;
      const capabilities = spawnSync("nvidia-smi", [], { encoding: "utf8", windowsHide: true });
      const cudaVersion = Number(/CUDA Version:\s*(\d+(?:\.\d+)?)/i.exec(capabilities.stdout)?.[1]);
      if (cudaVersion >= 13.3) availableBackends.push("cuda13");
      if (cudaVersion >= 12.4) availableBackends.push("cuda12");
    }
  } else if (process.platform === "linux") {
    const vulkan = spawnSync("vulkaninfo", ["--summary"], { encoding: "utf8" });
    if (vulkan.status === 0) availableBackends.push("vulkan");
    const rocm = spawnSync("rocminfo", [], { encoding: "utf8" });
    if (rocm.status === 0) {
      availableBackends.push("rocm");
      gpu = /Marketing Name:\s*(.+)/i.exec(rocm.stdout)?.[1]?.trim() ?? "AMD GPU";
      const memory = spawnSync("rocm-smi", ["--showmeminfo", "vram", "--json"], { encoding: "utf8" });
      const totals = memory.stdout.match(/"[^"\n]*Total[^"\n]*"\s*:\s*"?(\d+)/gi)?.map((entry) => Number(/(\d+)\s*$/.exec(entry.replace(/"/g, ""))?.[1])) ?? [];
      const detectedVram = Math.max(...totals.filter(Number.isFinite), 0);
      if (detectedVram > 0) vram = detectedVram;
    }
    const nvidia = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total,driver_version,compute_cap", "--format=csv,noheader,nounits"], { encoding: "utf8" });
    if (nvidia.status === 0 && nvidia.stdout.trim()) {
      const [name, memory, driver, computeCapability] = nvidia.stdout.trim().split(/\r?\n/, 1)[0]?.split(/,\s*/) ?? [];
      gpu = name;
      vram = Number(memory) * 1024 * 1024;
      const supportedComputeCapabilities = new Set(["7.5", "8.0", "8.6", "8.9", "9.0", "10.0", "12.0"]);
      if (Number(driver) >= 570.15 && supportedComputeCapabilities.has(computeCapability ?? "")) availableBackends.push("cuda12");
    }
  }
  return { platform: process.platform, architecture: process.arch, totalMemory: totalmem(), availableBackends: [...new Set(availableBackends)], ...(gpu ? { gpu } : {}), ...(vram ? { vram } : {}) };
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) { signal?.throwIfAborted(); hash.update(chunk as Buffer); }
  signal?.throwIfAborted();
  return hash.digest("hex");
}

function quantizationFromName(name: string): string | undefined {
  return /(?:^|[-_.])(IQ\d(?:_[A-Z0-9]+)?|Q\d(?:_[A-Z0-9]+)?|F16|F32|BF16)(?:[-_.]|$)/i.exec(name)?.[1]?.toUpperCase();
}

export async function readGgufMetadata(path: string): Promise<{ architecture?: string; parameterCount?: number; trainingContext?: number; blockCount?: number }> {
  const handle = await open(path, "r");
  try {
    const fileSize = (await handle.stat()).size;
    const header = Buffer.alloc(24);
    await handle.read(header, 0, header.length, 0);
    if (header.subarray(0, 4).toString("ascii") !== "GGUF") throw new Error("Not a GGUF file");
    const version = header.readUInt32LE(4);
    if (version < 2 || version > 3) throw new Error(`Unsupported GGUF version ${version}`);
    const keyCount = Number(header.readBigUInt64LE(16));
    if (!Number.isSafeInteger(keyCount) || keyCount > 100_000) throw new Error("Invalid GGUF metadata count");
    let offset = 24;
    const result: { architecture?: string; parameterCount?: number; trainingContext?: number; blockCount?: number } = {};
    const metadata = new Map<string, unknown>();
    const readAt = async (length: number) => { const buffer = Buffer.alloc(length); const loaded = await handle.read(buffer, 0, length, offset); if (loaded.bytesRead !== length) throw new Error("Truncated GGUF metadata"); offset += length; return buffer; };
    const readString = async () => { const length = Number((await readAt(8)).readBigUInt64LE()); if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024) throw new Error("Invalid GGUF string"); return (await readAt(length)).toString("utf8"); };
    const skipScalar = async (type: number): Promise<unknown> => {
      const widths: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
      if (type === 8) return readString();
      if (type === 9) { const elementType = (await readAt(4)).readUInt32LE(); const count = Number((await readAt(8)).readBigUInt64LE()); if (!Number.isSafeInteger(count) || count > 100_000_000) throw new Error("Invalid GGUF array"); const fixedWidth = widths[elementType]; if (fixedWidth) { const bytes = count * fixedWidth; if (!Number.isSafeInteger(bytes) || offset + bytes > fileSize) throw new Error("Invalid GGUF array size"); offset += bytes; return undefined; } for (let index = 0; index < count; index += 1) await skipScalar(elementType); return undefined; }
      const width = widths[type]; if (!width) throw new Error(`Unsupported GGUF value type ${type}`);
      const data = await readAt(width);
      if ([4, 5, 6].includes(type)) return data.readUInt32LE();
      if ([10, 11, 12].includes(type)) return Number(data.readBigUInt64LE());
      return undefined;
    };
    for (let index = 0; index < keyCount; index += 1) {
      const key = await readString();
      const type = (await readAt(4)).readUInt32LE();
      const value = await skipScalar(type);
      metadata.set(key, value);
      if (key === "general.architecture" && typeof value === "string") result.architecture = value;
      if (key === "general.parameter_count" && typeof value === "number") result.parameterCount = value;
      if (result.architecture && metadata.has(`${result.architecture}.context_length`) && metadata.has(`${result.architecture}.block_count`)) break;
    }
    if (result.architecture) {
      const context = metadata.get(`${result.architecture}.context_length`);
      const blocks = metadata.get(`${result.architecture}.block_count`);
      if (typeof context === "number") result.trainingContext = context;
      if (typeof blocks === "number") result.blockCount = blocks;
    }
    return result;
  } finally { await handle.close(); }
}

function sanitizeHeaders(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (!value || ["host", "connection", "content-length", "authorization"].includes(name.toLowerCase())) continue;
    result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}

export async function fetchWithRetry(url: URL | string, init: RequestInit = {}, attempts = 4): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts - 1) return response;
      lastError = new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (cause) {
      if (init.signal?.aborted || attempt === attempts - 1) throw cause;
      lastError = cause;
    }
    await delay(300 * 2 ** attempt, undefined, init.signal ? { signal: init.signal } : undefined);
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed after retrying");
}

async function requestBody(request: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) { const buffer = Buffer.from(chunk as Uint8Array); total += buffer.length; if (total > limit) throw new Error("Request body is too large"); chunks.push(buffer); }
  return Buffer.concat(chunks);
}

export function validateToolCallResponse(body: unknown): { assistant: JsonObject; arguments: JsonObject } {
  const choice = asObject(asArray(asObject(body).choices)[0]);
  const message = asObject(choice.message);
  const calls = asArray(message.tool_calls);
  if (calls.length !== 1) throw new Error("Model did not return exactly one standard tool call");
  const call = asObject(calls[0]);
  const fn = asObject(call.function);
  if (asString(call.type) !== "function" || asString(fn.name) !== "agent_k_tool_probe") throw new Error("Model returned the wrong tool name");
  if (typeof fn.arguments !== "string") throw new Error("Tool arguments must be a JSON string");
  let parsed: JsonObject;
  try { parsed = asObject(JSON.parse(fn.arguments)); } catch { throw new Error("Tool arguments are not valid JSON"); }
  if (parsed.value !== 37 || Object.keys(parsed).length !== 1) throw new Error("Model returned incorrect tool arguments");
  if (typeof call.id !== "string" || !call.id) throw new Error("Tool call is missing an ID");
  return { assistant: message, arguments: parsed };
}

export class LocalModelManager {
  private readonly root: string;
  private readonly modelsDirectory: string;
  private readonly downloadsDirectory: string;
  private readonly runtimeDirectory: string;
  private readonly registryPath: string;
  private readonly options: ManagerOptions;
  private registry: LocalModelRegistry = { version: 1, models: [], downloads: [] };
  private readonly hardware = detectHardware();
  private proxy?: Server;
  private proxyPort = 0;
  private readonly proxyToken = randomBytes(32).toString("hex");
  private server?: ChildProcessWithoutNullStreams;
  private serverStarting?: { modelId: string; promise: Promise<number> };
  private serverStartAbort?: AbortController;
  private serverPort = 0;
  private serverToken = "";
  private runningModelId?: string;
  private logs: string[] = [];
  private queuePromise?: Promise<void>;
  private shuttingDown = false;
  private abortDownload?: AbortController;
  private activeDownloadId?: string;
  private readonly cancelledDownloads = new Set<string>();
  private providerConflict?: string;
  private runtimeDownload?: RuntimeDownloadProgress;
  private verificationStage?: LocalModelVerificationStage;
  private runTransaction?: LocalModelRunTransaction;

  constructor(options: ManagerOptions) {
    this.options = options;
    this.root = resolve(options.rootPath ?? join(options.cachePath, "local-models"));
    this.modelsDirectory = join(this.root, "models");
    this.downloadsDirectory = join(this.root, "downloads");
    this.runtimeDirectory = join(this.root, "runtime");
    this.registryPath = join(this.root, "registry.json");
  }

  async initialize(): Promise<void> {
    if (!(["linux", "win32"] as NodeJS.Platform[]).includes(process.platform) || process.arch !== "x64") throw new Error("Local models currently require Windows x64 or Linux x64");
    await Promise.all([mkdir(this.modelsDirectory, { recursive: true }), mkdir(this.downloadsDirectory, { recursive: true }), mkdir(this.runtimeDirectory, { recursive: true })]);
    this.registry = await readJson<LocalModelRegistry>(this.registryPath, { version: 1, models: [], downloads: [] });
    this.registry.version = 1;
    this.registry.models = Array.isArray(this.registry.models) ? this.registry.models.map((model) => ({ ...model, config: validateConfig(model.config), status: model.status === "running" || model.status === "loading" ? "ready" : model.status })) : [];
    this.registry.downloads = Array.isArray(this.registry.downloads) ? this.registry.downloads.filter((task) => /^download-[a-f0-9]{16}$/.test(task.id) && (task.source === "huggingface" || task.source === "modelscope") && Array.isArray(task.files)).map((task) => ({ ...task, bytesPerSecond: 0, status: task.status === "downloading" || task.status === "verifying-download" ? "queued" : task.status })) : [];
    const previouslyActive = this.registry.activeModelId;
    for (const model of this.registry.models) {
      if (!validModelId(model.id)) { model.status = "missing"; model.error = "The persisted local model ID is invalid"; if (this.registry.activeModelId === model.id) this.registry.activeModelId = undefined; continue; }
      const modelDirectory = join(this.modelsDirectory, model.id);
      const present = await Promise.all(model.files.map(async (file) => { if (!isPathInside(modelDirectory, file.path)) return false; try { return (await stat(file.path)).isFile(); } catch { return false; } }));
      if (present.some((value) => !value)) { model.status = "missing"; model.error = "One or more GGUF files are missing"; if (this.registry.activeModelId === model.id) this.registry.activeModelId = undefined; }
      else if (model.compatibility === "verifying-tools" || ((model.compatibility === "tool-compatible" || model.compatibility === "tool-incompatible") && model.compatibilityKey !== this.compatibilityKey(model))) {
        model.compatibility = "unverified";
        model.compatibilityKey = undefined;
        model.compatibilityError = undefined;
        model.verifiedAt = undefined;
        model.status = "ready";
        model.error = undefined;
      }
      else if (model.compatibility === "unverified" && model.status === "failed" && /^Unable to provision the official llama\.cpp runtime:/.test(model.error ?? "") && await this.runtimeIsProvisioned(model)) {
        model.status = "ready";
        model.error = undefined;
        model.compatibilityError = undefined;
      }
    }
    const active = this.registry.activeModelId ? this.registry.models.find((model) => model.id === this.registry.activeModelId) : undefined;
    if (!active || active.compatibility !== "tool-compatible" || active.compatibilityKey !== this.compatibilityKey(active)) this.registry.activeModelId = undefined;
    await this.startProxy();
    try { await this.assertProviderOwnership(); }
    catch (cause) { this.providerConflict = errorMessage(cause); this.registry.activeModelId = undefined; }
    await this.syncProvider();
    if (previouslyActive && !this.registry.activeModelId) await this.options.migrateModelReferences(previouslyActive, undefined);
    await this.save();
    this.scheduleQueue();
  }

  snapshot(): LocalModelManagerSnapshot {
    return clone({ activeModelId: this.registry.activeModelId, runningModelId: this.runningModelId, models: this.registry.models, downloads: this.registry.downloads, hardware: this.hardware, proxyUrl: `http://127.0.0.1:${this.proxyPort}/v1`, storagePath: this.root, defaultStoragePath: resolve(join(this.options.cachePath, "local-models")), piBusy: this.options.piBusy(), ...(this.runtimeDownload ? { runtimeDownload: this.runtimeDownload } : {}), ...(this.verificationStage ? { verificationStage: this.verificationStage } : {}), ...(this.providerConflict ? { providerConflict: this.providerConflict } : {}) });
  }

  private async piBusy(): Promise<boolean> {
    return this.options.verifyPiBusy
      ? this.options.verifyPiBusy()
      : this.options.piBusy();
  }

  logsSnapshot(): string[] { return [...this.logs]; }

  async search(source: Exclude<LocalModelSource, "import">, query: string): Promise<HubModelResult[]> {
    const term = query.trim();
    if (!term) return [];
    if (source === "huggingface") {
      const base = this.options.endpoints?.huggingface ?? "https://huggingface.co";
      const url = new URL("api/models", `${base}/`);
      url.searchParams.set("search", term); url.searchParams.set("filter", "gguf"); url.searchParams.set("sort", "downloads"); url.searchParams.set("direction", "-1"); url.searchParams.set("limit", "30"); url.searchParams.set("full", "true");
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Hugging Face search failed: ${response.status}`);
      const candidates = asArray(await response.json()).flatMap((raw) => { const item = asObject(raw); const repository = asString(item.id); if (!repository) return []; return [{ source, repository, name: repository.split("/").pop() ?? repository, description: asString(item.description), downloads: Number(item.downloads) || undefined, gated: Boolean(item.gated), private: item.private === true }]; }).slice(0, 30);
      return this.confirmGgufSearchResults(source, candidates);
    }
    const base = this.options.endpoints?.modelscope ?? "https://modelscope.cn";
    const url = new URL("openapi/v1/models", `${base}/`);
    url.searchParams.set("search", term); url.searchParams.set("sort", "downloads"); url.searchParams.set("page_number", "1"); url.searchParams.set("page_size", "30");
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`ModelScope search failed: ${response.status}`);
    const body = asObject(await response.json());
    const data = asObject(body.Data ?? body.data);
    const candidates = asArray(data.Models ?? data.models ?? body.models).flatMap((raw) => { const item = asObject(raw); const repository = asString(item.Path) ?? asString(item.ModelId) ?? asString(item.id); if (!repository) return []; const tags = asArray(item.Tags ?? item.tags).map(String).join(" "); if (!/gguf/i.test(tags)) return []; return [{ source, repository, name: asString(item.Name) ?? asString(item.display_name) ?? repository.split("/").pop() ?? repository, description: asString(item.Description) ?? asString(item.description), downloads: Number(item.Downloads ?? item.downloads) || undefined, gated: item.Gated === true || item.gated === true, private: item.Private === true || item.private === true }]; }).slice(0, 30);
    return this.confirmGgufSearchResults(source, candidates);
  }

  private async confirmGgufSearchResults(source: Exclude<LocalModelSource, "import">, candidates: HubModelResult[]): Promise<HubModelResult[]> {
    const checked = await Promise.all(candidates.map(async (candidate) => {
      if (candidate.gated || candidate.private) return candidate;
      try { return (await this.inspectRepository(source, candidate.repository)).files.length > 0 ? candidate : undefined; }
      catch { return undefined; }
    }));
    return checked.filter((candidate): candidate is HubModelResult => Boolean(candidate)).slice(0, 30);
  }

  async inspectRepository(source: Exclude<LocalModelSource, "import">, input: string): Promise<{ repository: string; revision: string; files: HubGgufFile[]; downloadable: boolean; reason?: string }> {
    const repository = parseHubRepository(source, input);
    if (source === "huggingface") {
      const base = this.options.endpoints?.huggingface ?? "https://huggingface.co";
      const url = new URL(`api/models/${repository}`, `${base}/`); url.searchParams.set("revision", "main"); url.searchParams.set("blobs", "true");
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Hugging Face repository check failed: ${response.status}`);
      const body = asObject(await response.json());
      const revision = asString(body.sha) ?? "main";
      const files = asArray(body.siblings).flatMap((raw) => { const file = asObject(raw); const name = asString(file.rfilename); if (!name || extname(name).toLowerCase() !== ".gguf" || /mmproj/i.test(name)) return []; const shard = parseGgufShard(name); const lfs = asObject(file.lfs); return [{ name, size: Number(file.size ?? lfs.size) || 0, sha256: asString(lfs.sha256), group: shard.group, shardIndex: shard.index, shardCount: shard.count }]; });
      const blocked = body.private === true || Boolean(body.gated);
      return { repository, revision, files, downloadable: !blocked, ...(blocked ? { reason: "Private and gated repositories require a token and are not supported" } : {}) };
    }
    const base = this.options.endpoints?.modelscope ?? "https://modelscope.cn";
    const revision = "master";
    try {
      const metadataResponse = await fetch(new URL(`openapi/v1/models/${repository}`, `${base}/`), { signal: AbortSignal.timeout(15_000) });
      if (metadataResponse.ok) {
        const metadataBody = asObject(await metadataResponse.json()); const metadataData = asObject(metadataBody.data ?? metadataBody.Data); const metadata = asObject(metadataData.model ?? metadataData.Model ?? metadataData);
        if (metadata.private === true || metadata.Private === true || metadata.gated === true || metadata.Gated === true)
          return { repository, revision, files: [], downloadable: false, reason: "Private and gated repositories require a token and are not supported" };
      }
    } catch { /* The public legacy file API remains available on older ModelScope deployments. */ }
    const url = new URL(`api/v1/models/${repository}/repo/files`, `${base}/`); url.searchParams.set("Revision", revision); url.searchParams.set("Recursive", "true");
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`ModelScope repository check failed: ${response.status}`);
    const body = asObject(await response.json()); if (body.Success === false || body.success === false || (typeof body.Code === "number" && body.Code !== 200)) throw new Error(asString(body.Message) ?? asString(body.message) ?? "ModelScope repository check failed"); const data = asObject(body.Data ?? body.data);
    const files = asArray(data.Files ?? data.files ?? body.files).flatMap((raw) => { const file = asObject(raw); const name = asString(file.Path) ?? asString(file.Name) ?? asString(file.path); if (!name || extname(name).toLowerCase() !== ".gguf" || /mmproj/i.test(name)) return []; const shard = parseGgufShard(name); return [{ name, size: Number(file.Size ?? file.size) || 0, sha256: asString(file.Sha256 ?? file.sha256), group: shard.group, shardIndex: shard.index, shardCount: shard.count }]; });
    return { repository, revision, files, downloadable: true };
  }

  async enqueue(source: Exclude<LocalModelSource, "import">, input: string, selected: string): Promise<string> {
    const inspected = await this.inspectRepository(source, input);
    if (!inspected.downloadable) throw new Error(inspected.reason ?? "Repository cannot be downloaded");
    const group = completeShardGroup(inspected.files, selected);
    const base = source === "huggingface" ? this.options.endpoints?.huggingface ?? "https://huggingface.co" : this.options.endpoints?.modelscope ?? "https://modelscope.cn";
    const files = group.map((file) => ({ name: file.name, size: file.size, sha256: file.sha256, url: source === "huggingface" ? new URL(`${inspected.repository}/resolve/${encodeURIComponent(inspected.revision)}/${file.name.split("/").map(encodeURIComponent).join("/")}?download=true`, `${base}/`).toString() : new URL(`models/${inspected.repository}/resolve/${encodeURIComponent(inspected.revision)}/${file.name.split("/").map(encodeURIComponent).join("/")}`, `${base}/`).toString() }));
    for (const file of files) if (!(file.size > 0)) file.size = await remoteFileSize(file.url);
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    await this.ensureDiskSpace(totalBytes);
    const task: LocalModelDownloadTask = { id: randomId("download-"), source, repository: inspected.repository, revision: inspected.revision, files, completedBytes: 0, totalBytes, status: "queued", createdAt: Date.now(), updatedAt: Date.now() };
    this.registry.downloads.push(task); await this.saveAndEmit(); this.scheduleQueue(); return task.id;
  }

  async pauseDownload(id: string): Promise<void> {
    const task = this.task(id);
    if (task.status === "verifying-download") throw new Error("A download cannot be paused while its checksum is being verified");
    task.status = "paused"; task.bytesPerSecond = 0; task.updatedAt = Date.now();
    if (this.activeDownloadId === id) this.abortDownload?.abort();
    await this.saveAndEmit();
  }
  async resumeDownload(id: string): Promise<void> {
    const task = this.task(id);
    if (task.status === "failed" && /SHA-256 mismatch/i.test(task.error ?? "")) {
      await rm(join(this.downloadsDirectory, task.id), { recursive: true, force: true });
      task.completedBytes = 0;
      for (const file of task.files) file.etag = undefined;
    } else task.completedBytes = await this.downloadedBytes(task);
    task.status = "queued"; task.bytesPerSecond = 0; task.error = undefined; task.updatedAt = Date.now(); await this.saveAndEmit(); this.scheduleQueue();
  }
  async cancelDownload(id: string): Promise<void> {
    this.task(id);
    if (this.activeDownloadId === id) {
      this.cancelledDownloads.add(id);
      this.abortDownload?.abort();
      while (this.activeDownloadId === id) await new Promise((resume) => setTimeout(resume, 20));
    } else {
      this.registry.downloads = this.registry.downloads.filter((item) => item.id !== id);
      await rm(join(this.downloadsDirectory, id), { recursive: true, force: true });
      await this.saveAndEmit();
    }
  }

  async importGguf(path: string): Promise<string> {
    const source = resolve(path); const info = await stat(source); if (!info.isFile() || extname(source).toLowerCase() !== ".gguf" || /mmproj/i.test(basename(source))) throw new Error("Select a GGUF model file (not mmproj)");
    const shard = parseGgufShard(basename(source));
    const siblings = await readdir(dirname(source));
    const names = siblings.filter((name) => extname(name).toLowerCase() === ".gguf" && parseGgufShard(name).group === shard.group).sort((left, right) => parseGgufShard(left).index - parseGgufShard(right).index);
    if (names.length !== shard.count) throw new Error("The complete GGUF shard group is required");
    const sourceSizes = await Promise.all(names.map(async (name) => (await stat(join(dirname(source), name))).size));
    await this.ensureDiskSpace(sourceSizes.reduce((sum, size) => sum + size, 0));
    const id = this.uniqueModelId(safeId(shard.group.replace(/\.gguf$/i, "")));
    const target = join(this.modelsDirectory, id); await mkdir(target, { recursive: true });
    const files: LocalModelRecord["files"] = [];
    try {
      for (const name of names) { const input = join(dirname(source), name); const output = join(target, name); await copyFile(input, output); const metadata = await stat(output); files.push({ name, path: output, size: metadata.size, sha256: await sha256File(output) }); }
      const primary = files[0]; if (!primary) throw new Error("No GGUF files were imported");
      const gguf = await readGgufMetadata(primary.path);
      const model: LocalModelRecord = { id, name: shard.group.replace(/\.gguf$/i, ""), source: "import", files, size: files.reduce((sum, file) => sum + file.size, 0), sha256: createHash("sha256").update(files.map((file) => file.sha256).join(":"), "utf8").digest("hex"), ...gguf, quantization: quantizationFromName(primary.name), compatibility: "unverified", config: this.recommendedConfig(gguf.trainingContext), status: "ready", createdAt: Date.now(), updatedAt: Date.now() };
      this.registry.models.push(model); await this.saveAndEmit(); return id;
    } catch (cause) { await rm(target, { recursive: true, force: true }); throw cause; }
  }

  async updateConfig(id: string, patch: Partial<LocalModelRuntimeConfig>): Promise<void> {
    const model = this.model(id); const next = validateConfig(patch, model.config); const changed = JSON.stringify(next) !== JSON.stringify(model.config); if (!changed) return;
    const wasActive = this.registry.activeModelId === id;
    if (wasActive && await this.piBusy()) throw new Error("Wait for all Pi runtimes to become idle before changing the active local model");
    if (wasActive && this.runningModelId === id) await this.stopServer();
    const previous = { config: model.config, compatibility: model.compatibility, compatibilityKey: model.compatibilityKey, compatibilityError: model.compatibilityError, verifiedAt: model.verifiedAt, status: model.status, error: model.error };
    model.config = next; model.updatedAt = Date.now(); model.compatibility = "unverified"; model.compatibilityKey = undefined; model.compatibilityError = undefined; model.verifiedAt = undefined; model.status = "ready"; model.error = undefined;
    if (!wasActive) { await this.saveAndEmit(); return; }
    this.registry.activeModelId = undefined;
    try { await this.syncProvider(); await this.saveAndEmit(); await this.options.reloadPi(); await this.options.migrateModelReferences(id, undefined); }
    catch (cause) {
      Object.assign(model, previous); this.registry.activeModelId = id; await this.syncProvider(); await this.saveAndEmit(); await this.options.reloadPi().catch(() => undefined); throw cause;
    }
  }

  async verify(id: string): Promise<void> {
    const model = this.model(id); const wasActive = this.registry.activeModelId === id;
    if (wasActive && await this.piBusy()) throw new Error("Wait for all Pi runtimes to become idle before revalidating the active local model");
    if (this.runningModelId && this.runningModelId !== id) await this.stop();
    const key = this.compatibilityKey(model);
    model.compatibility = "verifying-tools"; model.status = "verifying-tools"; model.compatibilityError = undefined; await this.saveAndEmit();
    this.setVerificationStage({ modelId: id, phase: "preparing-runtime" });
    try {
      const deadline = await this.startModel(model, true);
      await this.runToolVerification(model, deadline);
      model.compatibility = "tool-compatible"; model.compatibilityKey = key; model.verifiedAt = Date.now(); model.status = "ready"; model.error = undefined;
    } catch (cause) {
      if (cause instanceof RuntimeProvisionError) { model.compatibility = "unverified"; model.compatibilityKey = undefined; }
      else { model.compatibility = "tool-incompatible"; model.compatibilityKey = key; }
      model.compatibilityError = errorMessage(cause); model.status = "failed"; model.error = errorMessage(cause); throw cause;
    } finally {
      this.setVerificationStage(undefined);
      await this.stopServer();
      if (wasActive && model.compatibility !== "tool-compatible" && this.registry.activeModelId === id) {
        this.registry.activeModelId = undefined;
        await this.syncProvider();
        await this.options.migrateModelReferences(id, undefined);
        await this.options.reloadPi();
      }
      await this.saveAndEmit();
    }
  }

  async activate(id: string): Promise<void> {
    if (await this.piBusy()) throw new Error("Wait for all Pi runtimes to become idle before switching the local model");
    const model = this.model(id); const key = this.compatibilityKey(model);
    if (model.compatibility !== "tool-compatible" || model.compatibilityKey !== key) await this.verify(id);
    if (model.compatibility !== "tool-compatible") throw new Error("This model is not tool-call compatible and cannot be activated");
    if (await this.piBusy()) throw new Error("Wait for all Pi runtimes to become idle before switching the local model");
    const previous = this.registry.activeModelId;
    if (this.runningModelId && this.runningModelId !== id) await this.stop();
    await this.assertProviderOwnership();
    this.registry.activeModelId = id;
    try {
      // Do not emit the new active model until Pi has reloaded it. The renderer
      // responds to this event by reading Pi state; that harmless read used to
      // race with reload(), make the runtime briefly unavailable, and roll the
      // activation back to the previous model.
      await this.syncProvider(); await this.options.migrateModelReferences(previous, id); await this.options.reloadPi(); await this.saveAndEmit();
    } catch (cause) {
      this.registry.activeModelId = previous; await this.syncProvider();
      await this.options.migrateModelReferences(id, previous).catch(() => undefined);
      await this.options.reloadPi().catch(() => undefined);
      await this.saveAndEmit();
      throw cause;
    }
  }

  async run(id: string): Promise<void> { const model = this.model(id); if (this.registry.activeModelId !== id || model.compatibility !== "tool-compatible" || model.compatibilityKey !== this.compatibilityKey(model)) throw new Error("Only the current tool-compatible local model can run"); await this.startModel(model, false); await this.saveAndEmit(); }
  async stop(): Promise<void> { if (await this.piBusy()) throw new Error("Wait for Pi to stop before unloading the local model"); this.serverStartAbort?.abort(); await this.serverStarting?.promise.catch(() => undefined); await this.stopServer(); await this.saveAndEmit(); }

  async delete(id: string): Promise<void> {
    const model = this.model(id); const wasActive = this.registry.activeModelId === id;
    if (wasActive && await this.piBusy()) throw new Error("Wait for all Pi runtimes to become idle before deleting the active model");
    if (this.runningModelId === id) await this.stopServer();
    if (this.registry.activeModelId === id) {
      this.registry.activeModelId = undefined;
      try { await this.syncProvider(); await this.saveAndEmit(); await this.options.reloadPi(); await this.options.migrateModelReferences(id, undefined); }
      catch (cause) { this.registry.activeModelId = id; await this.syncProvider(); await this.saveAndEmit(); await this.options.reloadPi().catch(() => undefined); throw cause; }
    }
    await rm(join(this.modelsDirectory, id), { recursive: true, force: true }); this.registry.models = this.registry.models.filter((item) => item.id !== id); await this.saveAndEmit();
  }

  async shutdown(): Promise<void> { this.shuttingDown = true; for (const task of this.registry.downloads) if (task.status === "downloading" || task.status === "verifying-download") task.status = "queued"; this.abortDownload?.abort(); this.serverStartAbort?.abort(); await this.queuePromise?.catch(() => undefined); await this.serverStarting?.promise.catch(() => undefined); await this.save(); await this.stopServer(); const proxy = this.proxy; if (proxy) await new Promise<void>((resolveClose) => { proxy.close(() => resolveClose()); proxy.closeAllConnections(); }); this.proxy = undefined; }

  private model(id: string): LocalModelRecord { const model = this.registry.models.find((item) => item.id === id); if (!model) throw new Error("Local model was not found"); return model; }
  private task(id: string): LocalModelDownloadTask { const task = this.registry.downloads.find((item) => item.id === id); if (!task) throw new Error("Download task was not found"); return task; }
  private uniqueModelId(base: string): string { let id = base; let suffix = 2; while (this.registry.models.some((model) => model.id === id)) id = `${base}-${suffix++}`; return id; }
  private recommendedConfig(trainingContext?: number): LocalModelRuntimeConfig { const available = Math.max(freemem(), 1); const target = Math.min(trainingContext || 32_768, available < 8 * 1024 ** 3 ? 4_096 : available < 16 * 1024 ** 3 ? 8_192 : available < 32 * 1024 ** 3 ? 16_384 : 32_768); const contextSize = ([32_768, 16_384, 8_192, 4_096] as const).find((size) => size <= target) ?? 4_096; return { ...DEFAULT_CONFIG, contextSize, maxOutputTokens: Math.min(DEFAULT_CONFIG.maxOutputTokens, Math.floor(contextSize / 2)) } as LocalModelRuntimeConfig; }
  private resolvedBackend(model: LocalModelRecord): Exclude<LocalModelBackend, "auto"> {
    if (model.config.backend !== "auto") return model.config.backend;
    return selectAutomaticBackend(process.platform, this.hardware.availableBackends);
  }
  private resolvedGpuLayers(model: LocalModelRecord, backend: Exclude<LocalModelBackend, "auto">): number | "auto" { return resolveGpuLayers(backend, model.config.gpuLayers); }
  private compatibilityKey(model: LocalModelRecord): string { const backend = this.resolvedBackend(model); const runtime = LLAMA_RUNTIME_ASSETS[`${process.platform}-${backend}`]; return createHash("sha256").update(JSON.stringify({ files: model.files.map((file) => file.sha256), build: LLAMA_CPP_BUILD, runtime: runtime ? runtimeAssetChain(runtime).map((asset) => asset.sha256) : [], backend, contextSize: model.config.contextSize, gpuLayers: this.resolvedGpuLayers(model, backend), threads: model.config.threads, cacheTypeK: model.config.cacheTypeK, cacheTypeV: model.config.cacheTypeV, maxOutputTokens: model.config.maxOutputTokens, reasoning: model.config.reasoning, jinja: true })).digest("hex"); }
  private async runtimeIsProvisioned(model: LocalModelRecord): Promise<boolean> {
    if (this.options.runtimeOverride) return existsSync(this.options.runtimeOverride.executable);
    const backend = this.resolvedBackend(model);
    const asset = LLAMA_RUNTIME_ASSETS[`${process.platform}-${backend}`];
    if (!asset) return false;
    const destination = join(this.runtimeDirectory, LLAMA_CPP_BUILD, backend);
    const executable = await findExecutable(destination);
    if (!executable) return false;
    const expectedManifest = { build: LLAMA_CPP_BUILD, backend, assets: runtimeAssetChain(asset).map(({ name, sha256 }) => ({ name, sha256 })) };
    return JSON.stringify(await readJson(join(destination, ".agent-k-runtime.json"), {})) === JSON.stringify(expectedManifest);
  }
  private addLog(line: string): void { this.logs.push(...line.replace(/\r/g, "").split("\n").filter(Boolean).map((entry) => `${new Date().toISOString()} ${entry}`)); if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES); this.options.emit({ type: "local_models_changed", phase: "log" }); }
  private async save(): Promise<void> { await atomicWrite(this.registryPath, JSON.stringify(this.registry, null, 2)); }
  private async saveAndEmit(): Promise<void> { await this.save(); this.options.emit({ type: "local_models_changed" }); }

  private async ensureDiskSpace(bytes: number): Promise<void> { const available = await statfsAvailable(this.root); if (available !== undefined && available < bytes + Math.min(bytes / 10, 1024 ** 3)) throw new Error("Not enough free disk space for this model"); }

  private scheduleQueue(): void {
    if (this.queuePromise || this.shuttingDown) return;
    this.queuePromise = this.processQueue().finally(() => {
      this.queuePromise = undefined;
      if (!this.shuttingDown && this.registry.downloads.some((task) => task.status === "queued")) this.scheduleQueue();
    });
  }

  private async processQueue(): Promise<void> {
    for (;;) {
      if (this.shuttingDown) break; const task = this.registry.downloads.find((item) => item.status === "queued"); if (!task) break;
      task.status = "downloading"; task.bytesPerSecond = 0; task.error = undefined; this.activeDownloadId = task.id; await this.saveAndEmit(); this.abortDownload = new AbortController();
      try {
        await this.downloadTask(task, this.abortDownload.signal);
        const current = this.registry.downloads.find((item) => item.id === task.id); if (!current || current.status === "paused" || this.cancelledDownloads.has(task.id)) continue;
        current.status = "verifying-download"; current.bytesPerSecond = 0; await this.saveAndEmit(); await this.finishDownload(current, this.abortDownload.signal);
        if (this.cancelledDownloads.has(task.id)) continue;
        this.registry.downloads = this.registry.downloads.filter((item) => item.id !== current.id); await rm(join(this.downloadsDirectory, current.id), { recursive: true, force: true }); await this.saveAndEmit();
      } catch (cause) {
        const current = this.registry.downloads.find((item) => item.id === task.id);
        if (current && !this.cancelledDownloads.has(task.id) && current.status !== "paused" && current.status !== "queued") { current.status = "failed"; current.error = errorMessage(cause); current.updatedAt = Date.now(); await this.saveAndEmit(); }
      } finally {
        if (this.cancelledDownloads.delete(task.id)) { this.registry.downloads = this.registry.downloads.filter((item) => item.id !== task.id); await rm(join(this.downloadsDirectory, task.id), { recursive: true, force: true }); await this.saveAndEmit(); }
        this.abortDownload = undefined; this.activeDownloadId = undefined;
      }
    }
  }

  private async downloadTask(task: LocalModelDownloadTask, signal: AbortSignal): Promise<void> {
    const directory = join(this.downloadsDirectory, task.id); await mkdir(directory, { recursive: true });
    const startedAt = Date.now();
    const initialBytes = task.completedBytes;
    let lastProgressEvent = 0;
    for (const file of task.files) {
      const partial = join(directory, `${basename(file.name)}.partial`); let offset = 0; try { offset = (await stat(partial)).size; } catch { /* New download. */ }
      const headers: Record<string, string> = {}; if (offset) { headers.Range = `bytes=${offset}-`; if (file.etag) headers["If-Range"] = file.etag; }
      const response = await fetch(file.url, { headers, redirect: "follow", signal }); if (!(response.ok || response.status === 206) || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
      const etag = response.headers.get("etag") ?? undefined; if (offset && response.status !== 206) { await rm(partial, { force: true }); offset = 0; }
      if (offset && file.etag && etag && file.etag !== etag) { await rm(partial, { force: true }); throw new Error("Remote file changed while resuming; retry the download"); }
      file.etag = etag;
      const stream = createWriteStream(partial, { flags: offset ? "a" : "w" }); let written = offset;
      try { for await (const chunk of webStreamChunks(response.body)) { signal.throwIfAborted(); const buffer = Buffer.from(chunk); if (!stream.write(buffer)) await new Promise<void>((resolveDrain) => stream.once("drain", resolveDrain)); written += buffer.length; task.completedBytes = await this.downloadedBytes(task); task.updatedAt = Date.now(); task.bytesPerSecond = Math.max(0, task.completedBytes - initialBytes) / Math.max((task.updatedAt - startedAt) / 1_000, 0.001); if (task.updatedAt - lastProgressEvent >= 200) { lastProgressEvent = task.updatedAt; this.options.emit({ type: "local_models_changed", phase: "model-download" }); } if (written % (4 * 1024 * 1024) < buffer.length) await this.saveAndEmit(); } } finally { await new Promise<void>((resolveClose) => stream.end(resolveClose)); }
      if (file.size > 0 && written !== file.size) throw new Error(`Downloaded size mismatch for ${file.name}: expected ${file.size}, received ${written}`);
    }
  }

  private async downloadedBytes(task: LocalModelDownloadTask): Promise<number> { let total = 0; for (const file of task.files) try { total += (await stat(join(this.downloadsDirectory, task.id, `${basename(file.name)}.partial`))).size; } catch { /* Missing partial. */ } return total; }

  private async finishDownload(task: LocalModelDownloadTask, signal: AbortSignal): Promise<void> {
    const id = this.uniqueModelId(safeId(parseGgufShard(basename(task.files[0]?.name ?? task.repository)).group.replace(/\.gguf$/i, ""))); const directory = join(this.modelsDirectory, id); await mkdir(directory, { recursive: true }); const files: LocalModelRecord["files"] = [];
    try {
      for (const remote of task.files) { signal.throwIfAborted(); const partial = join(this.downloadsDirectory, task.id, `${basename(remote.name)}.partial`); const digest = await sha256File(partial, signal); if (remote.sha256 && digest.toLowerCase() !== remote.sha256.toLowerCase()) throw new Error(`SHA-256 mismatch for ${remote.name}`); signal.throwIfAborted(); const output = join(directory, basename(remote.name)); await rename(partial, output); const metadata = await stat(output); files.push({ name: remote.name, path: output, size: metadata.size, sha256: digest }); }
      const first = files[0]; if (!first) throw new Error("Download did not contain a GGUF file"); signal.throwIfAborted(); const gguf = await readGgufMetadata(first.path); signal.throwIfAborted(); this.registry.models.push({ id, name: parseGgufShard(basename(first.name)).group.replace(/\.gguf$/i, ""), source: task.source, repository: task.repository, revision: task.revision, files, size: files.reduce((sum, file) => sum + file.size, 0), sha256: createHash("sha256").update(files.map((file) => file.sha256).join(":"), "utf8").digest("hex"), ...gguf, quantization: quantizationFromName(first.name), compatibility: "unverified", config: this.recommendedConfig(gguf.trainingContext), status: "ready", createdAt: Date.now(), updatedAt: Date.now() });
    } catch (cause) { await rm(directory, { recursive: true, force: true }); throw cause; }
  }

  private async provisionRuntime(backend: Exclude<LocalModelBackend, "auto">, modelId: string, signal: AbortSignal): Promise<string> {
    const key = `${process.platform}-${backend}`; const asset = LLAMA_RUNTIME_ASSETS[key]; if (!asset) throw new Error(`llama.cpp ${backend} runtime is not published for ${process.platform} x64`);
    const assets = runtimeAssetChain(asset);
    const destination = join(this.runtimeDirectory, LLAMA_CPP_BUILD, backend); const manifestPath = join(destination, ".agent-k-runtime.json"); const expectedManifest = { build: LLAMA_CPP_BUILD, backend, assets: assets.map(({ name, sha256 }) => ({ name, sha256 })) }; const executable = await findExecutable(destination); const manifest = await readJson(manifestPath, {}); if (executable && JSON.stringify(manifest) === JSON.stringify(expectedManifest)) return executable;
    await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true });
    const updateProgress = (progress?: RuntimeDownloadProgress) => {
      this.runtimeDownload = progress;
      this.options.emit({ type: "local_models_changed", phase: "runtime-download" });
      if (progress && this.runTransaction?.modelId === modelId) {
        const phase = progress.phase === "downloading" ? "downloading-runtime" : progress.phase === "verifying" ? "verifying-runtime" : "extracting-runtime";
        this.emitRunProgress(phase, 0, 4, "progress", progress.fileName, progress.completedBytes, progress.totalBytes);
      }
    };
    const downloadOne = async (item: RuntimeAsset) => {
      signal.throwIfAborted();
      const archive = join(this.runtimeDirectory, item.name);
      const repository = item.repository ?? "ggml-org/llama.cpp";
      const source = item.source ?? (item.thirdParty ? `${repository} · third-party` : repository);
      let archiveReady = false;
      if (existsSync(archive)) {
        const size = (await stat(archive)).size;
        updateProgress({ modelId, backend, source, fileName: item.name, phase: "verifying", completedBytes: size, totalBytes: size, bytesPerSecond: 0 });
        archiveReady = await sha256File(archive, signal) === item.sha256;
      }
      if (!archiveReady) {
        const base = this.options.endpoints?.github ?? `https://github.com/${repository}/releases/download/${LLAMA_CPP_BUILD}/`;
        const downloadUrl = this.options.endpoints?.github ? new URL(item.name, base) : item.url ? new URL(item.url) : new URL(item.name, base);
        const temporary = `${archive}.partial`;
        let offset = 0;
        try { offset = (await stat(temporary)).size; } catch { /* New runtime download. */ }
        const request = (resumeAt: number) => fetchWithRetry(downloadUrl, {
          headers: resumeAt > 0 ? { Range: `bytes=${resumeAt}-` } : undefined,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
        });
        let response = await request(offset);
        if (offset > 0 && response.status === 416) {
          await response.body?.cancel();
          if (await sha256File(temporary, signal) === item.sha256) { await rename(temporary, archive); archiveReady = true; }
          else { await rm(temporary, { force: true }); offset = 0; response = await request(0); }
        }
        if (!archiveReady) {
          if (!response.ok || !response.body) throw new Error(`llama.cpp runtime download failed: HTTP ${response.status}`);
          const resumed = offset > 0 && response.status === 206;
          if (!resumed) offset = 0;
          const rangeTotal = Number(/\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "")?.[1]);
          const responseLength = Number(response.headers.get("content-length")) || 0;
          const totalBytes = Number.isSafeInteger(rangeTotal) && rangeTotal > 0 ? rangeTotal : responseLength > 0 ? responseLength + offset : 0;
          const stream = createWriteStream(temporary, { flags: resumed ? "a" : "w" });
          const startedAt = Date.now();
          const initialBytes = offset;
          let completedBytes = offset;
          let lastUpdate = 0;
          updateProgress({ modelId, backend, source, fileName: item.name, phase: "downloading", completedBytes, totalBytes, bytesPerSecond: 0 });
          try {
            for await (const chunk of webStreamChunks(response.body)) {
              signal.throwIfAborted();
              const buffer = Buffer.from(chunk);
              if (!stream.write(buffer)) await new Promise<void>((resolveDrain) => stream.once("drain", resolveDrain));
              completedBytes += buffer.length;
              const now = Date.now();
              if (now - lastUpdate >= 200 || (totalBytes > 0 && completedBytes >= totalBytes)) {
                lastUpdate = now;
                updateProgress({ modelId, backend, source, fileName: item.name, phase: "downloading", completedBytes, totalBytes, bytesPerSecond: (completedBytes - initialBytes) / Math.max((now - startedAt) / 1_000, 0.001) });
              }
            }
          } finally { await new Promise<void>((resolveClose) => stream.end(resolveClose)); }
          updateProgress({ modelId, backend, source, fileName: item.name, phase: "verifying", completedBytes, totalBytes: totalBytes || completedBytes, bytesPerSecond: (completedBytes - initialBytes) / Math.max((Date.now() - startedAt) / 1_000, 0.001) });
          if (await sha256File(temporary, signal) !== item.sha256) { await rm(temporary, { force: true }); throw new Error(`SHA-256 mismatch for pinned runtime ${item.name}`); }
          await rename(temporary, archive);
        }
      }
      signal.throwIfAborted();
      const archiveSize = (await stat(archive)).size;
      updateProgress({ modelId, backend, source, fileName: item.name, phase: "extracting", completedBytes: archiveSize, totalBytes: archiveSize, bytesPerSecond: 0 });
      await mkdir(destination, { recursive: true });
      if (item.name.endsWith(".zip") || item.name.endsWith(".whl")) await extractZip(archive, { dir: destination }); else await extractTar(archive, destination);
    };
    try {
      for (const runtimeAsset of assets) await downloadOne(runtimeAsset);
      const ready = await findExecutable(destination);
      if (!ready) throw new Error("Pinned runtime archive did not contain llama-server");
      if (process.platform !== "win32") await import("node:fs/promises").then(({ chmod }) => chmod(ready, 0o755));
      await atomicWrite(manifestPath, JSON.stringify(expectedManifest, null, 2));
      return ready;
    } finally { updateProgress(undefined); }
  }

  private async startModel(model: LocalModelRecord, temporary: boolean): Promise<number> {
    const timeout = this.options.verificationTimeoutMs ?? VERIFY_TIMEOUT_MS;
    if (this.server && this.runningModelId === model.id) return Date.now() + timeout;
    if (this.serverStarting) {
      const deadline = await this.serverStarting.promise;
      if (this.server && this.runningModelId === model.id) return deadline;
    }
    const controller = new AbortController(); this.serverStartAbort = controller;
    const transaction = temporary ? undefined : { id: randomId("local-model-run-"), modelId: model.id, modelName: model.name };
    if (transaction) {
      this.runTransaction = transaction;
      this.emitRunProgress("preparing-runtime", 0, 4);
    }
    const promise = this.startModelInternal(model, temporary, timeout, controller.signal);
    this.serverStarting = { modelId: model.id, promise };
    try {
      const deadline = await promise;
      if (transaction) this.emitRunProgress("ready", 4, 4, "complete");
      return deadline;
    }
    catch (cause) {
      if (this.server && this.runningModelId === model.id) await this.stopServer();
      if (controller.signal.aborted) { model.status = "ready"; model.error = undefined; }
      else { model.status = "failed"; model.error ??= errorMessage(cause); }
      if (transaction) this.emitRunProgress("health-check", 3, 4, controller.signal.aborted ? "cancelled" : "failed", errorMessage(cause));
      await this.saveAndEmit(); throw cause;
    }
    finally {
      if (this.runTransaction?.id === transaction?.id) this.runTransaction = undefined;
      if (this.serverStarting?.promise === promise) { this.serverStarting = undefined; this.serverStartAbort = undefined; }
    }
  }

  private async startModelInternal(model: LocalModelRecord, temporary: boolean, timeout: number, signal: AbortSignal): Promise<number> {
    if (this.server && this.runningModelId === model.id) return Date.now() + timeout;
    if (this.server) await this.stopServer();
    const backend = this.resolvedBackend(model); model.status = "provisioning"; model.error = undefined; await this.saveAndEmit();
    const runtime = this.options.runtimeOverride;
    let executable = runtime?.executable;
    if (!executable) {
      try { executable = await this.provisionRuntime(backend, model.id, signal); }
      catch (cause) { throw new RuntimeProvisionError(cause); }
    }
    signal.throwIfAborted();
    if (!temporary) this.emitRunProgress("starting-server", 1, 4);
    const deadline = Date.now() + timeout;
    const port = await randomPort(); const token = randomBytes(32).toString("hex"); const args = [...(runtime?.args ?? []), "--model", model.files[0]?.path ?? "", "--host", "127.0.0.1", "--port", String(port), "--api-key", token, "--alias", model.id, "--ctx-size", String(model.config.contextSize), "--n-gpu-layers", String(backend === "cpu" ? 0 : model.config.gpuLayers), "--cache-type-k", model.config.cacheTypeK, "--cache-type-v", model.config.cacheTypeV, "--jinja", "--cache-prompt"];
    args[args.indexOf("--n-gpu-layers") + 1] = String(this.resolvedGpuLayers(model, backend));
    if (model.config.threads > 0) args.push("--threads", String(model.config.threads));
    const environment = { ...process.env };
    if (process.platform === "linux" && !runtime) {
      const libraryDirectories = await findLibraryDirectories(join(this.runtimeDirectory, LLAMA_CPP_BUILD, backend));
      if (libraryDirectories.length) environment.LD_LIBRARY_PATH = [...libraryDirectories, ...(process.env.LD_LIBRARY_PATH ? [process.env.LD_LIBRARY_PATH] : [])].join(delimiter);
    }
    if (temporary) this.setVerificationStage({ modelId: model.id, phase: "loading-model" });
    model.status = temporary ? "verifying-tools" : "loading"; this.serverPort = port; this.serverToken = token; this.runningModelId = model.id;
    const child = spawn(executable, args, { cwd: dirname(executable), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: environment });
    const startupErrors: string[] = [];
    child.stdin.end(); this.server = child;
    child.stdout.on("data", (chunk: Buffer) => this.addLog(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      const output = chunk.toString(); this.addLog(output);
      startupErrors.push(...output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
      if (startupErrors.length > 20) startupErrors.splice(0, startupErrors.length - 20);
    });
    child.once("error", (cause) => { if (this.server === child) { this.server = undefined; this.runningModelId = undefined; model.status = "failed"; model.error = `Unable to start llama-server: ${errorMessage(cause)}`; } });
    child.once("exit", (code, exitSignal) => { if (this.server === child && this.runningModelId === model.id) { this.server = undefined; this.runningModelId = undefined; model.status = "failed"; const detail = startupErrors.slice(-4).join(" | "); model.error = `llama-server exited (${code ?? exitSignal ?? "unknown"})${detail ? `: ${detail}` : ""}`; void this.saveAndEmit(); } });
    await this.saveAndEmit();
    if (!temporary) this.emitRunProgress("loading-model", 2, 4);
    if (!temporary) this.emitRunProgress("health-check", 3, 4);
    await this.waitForHealth(model, deadline, signal); if (!temporary) model.status = "running"; return deadline;
  }

  private async waitForHealth(model: LocalModelRecord, deadline: number, signal: AbortSignal): Promise<void> { while (Date.now() < deadline) { signal.throwIfAborted(); if (!this.server) throw new Error(model.error ?? "llama-server exited while loading"); try { const response = await this.internalFetch("/health", { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now())))]) }); const health = response.ok ? asObject(await response.json()) : {}; if (response.ok && health.status === "ok") return; } catch (cause) { if (signal.aborted) throw cause; } await new Promise((resume) => setTimeout(resume, Math.min(350, Math.max(1, deadline - Date.now())))); } throw new Error("llama-server did not become healthy within 90 seconds"); }

  private async runToolVerification(model: LocalModelRecord, deadline: number): Promise<void> {
    const verificationSignal = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    this.setVerificationStage({ modelId: model.id, phase: "checking-template" });
    const propsResponse = await this.internalFetch("/props", { signal: verificationSignal() }); if (!propsResponse.ok) throw new Error(`/props failed: HTTP ${propsResponse.status}`); const props = asObject(await propsResponse.json()); const template = asString(props.chat_template) ?? asString(asObject(props.default_generation_settings).chat_template); if (!template) throw new Error("The GGUF has no usable chat template");
    const tool = { type: "function", function: { name: "agent_k_tool_probe", description: "Return a deterministic probe value", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } } };
    // llama.cpp b10182 accepts the OpenAI string form for tool_choice. With a
    // single named tool, "required" is equivalent to forcing that exact tool.
    const firstRequest = { model: model.id, messages: [{ role: "user", content: "Call agent_k_tool_probe with value 37. Do not answer in text." }], tools: [tool], tool_choice: "required", chat_template_kwargs: { enable_thinking: false }, temperature: 0, max_tokens: 1_024, stream: false };
    this.setVerificationStage({ modelId: model.id, phase: "requesting-tool-call" });
    const firstResponse = await this.internalFetch("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(firstRequest), signal: verificationSignal() }); if (!firstResponse.ok) throw new Error(`Forced tool call failed: HTTP ${firstResponse.status} ${await firstResponse.text()}`); const firstBody: unknown = await firstResponse.json(); let parsed: ReturnType<typeof validateToolCallResponse>; try { parsed = validateToolCallResponse(firstBody); } catch (cause) { throw new Error(`${errorMessage(cause)}. Response: ${JSON.stringify(firstBody).slice(0, 4_000)}`); } const toolCall = asObject(asArray(parsed.assistant.tool_calls)[0]);
    const secondRequest = { ...firstRequest, tool_choice: "none", messages: [...firstRequest.messages, parsed.assistant, { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ ok: true, value: 37 }) }] };
    this.setVerificationStage({ modelId: model.id, phase: "checking-tool-result" });
    const secondResponse = await this.internalFetch("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(secondRequest), signal: verificationSignal() }); if (!secondResponse.ok) throw new Error(`Tool-result continuation failed: HTTP ${secondResponse.status} ${await secondResponse.text()}`); const secondMessage = asObject(asObject(asArray(asObject(await secondResponse.json()).choices)[0]).message); if (typeof secondMessage.content !== "string" || !secondMessage.content.trim() || asArray(secondMessage.tool_calls).length) throw new Error("Model could not continue with a normal answer after receiving a tool result");
  }

  private setVerificationStage(stage?: LocalModelVerificationStage): void { this.verificationStage = stage; this.options.emit({ type: "local_models_changed", phase: "tool-verification" }); }

  private emitRunProgress(phase: LocalModelRunPhase, completed: number, total: number, status: "progress" | "complete" | "failed" | "cancelled" = "progress", detail?: string, bytesCompleted?: number, bytesTotal?: number): void {
    const transaction = this.runTransaction;
    if (!transaction) return;
    this.options.emit({ type: "local_model_run_progress", transactionId: transaction.id, modelId: transaction.modelId, modelName: transaction.modelName, phase, completed, total, status, ...(detail ? { detail } : {}), ...(bytesCompleted !== undefined ? { bytesCompleted } : {}), ...(bytesTotal !== undefined ? { bytesTotal } : {}) });
  }

  private internalFetch(path: string, init: RequestInit): Promise<Response> { const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${this.serverToken}`); return fetch(`http://127.0.0.1:${this.serverPort}${path}`, { ...init, headers }); }
  private async stopServer(): Promise<void> { const child = this.server; const id = this.runningModelId; if (!child) return; this.server = undefined; this.runningModelId = undefined; if (id) { const model = this.registry.models.find((item) => item.id === id); if (model) model.status = "stopping"; } child.kill(); await Promise.race([new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())), new Promise<void>((resolveWait) => setTimeout(resolveWait, 3_000))]); if (child.exitCode === null) child.kill("SIGKILL"); if (id) { const model = this.registry.models.find((item) => item.id === id); if (model) model.status = "ready"; } }

  private async startProxy(): Promise<void> { this.proxy = createServer((request, response) => void this.handleProxy(request, response)); await new Promise<void>((resolveListen, rejectListen) => { this.proxy?.once("error", rejectListen); this.proxy?.listen(0, "127.0.0.1", () => resolveListen()); }); const address = this.proxy.address(); if (!address || typeof address === "string") throw new Error("Unable to start local model proxy"); this.proxyPort = address.port; }
  private async handleProxy(request: IncomingMessage, response: ServerResponse): Promise<void> { const disconnected = new AbortController(); response.once("close", () => { if (!response.writableEnded) disconnected.abort(); }); try { if (request.headers.authorization !== `Bearer ${this.proxyToken}`) { this.reply(response, 401, { error: { message: "Invalid Agent K local model token" } }); return; } const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname; if (pathname !== "/v1/chat/completions") { this.reply(response, 404, { error: { message: "Only Chat Completions is available through the Agent K local model proxy" } }); return; } let body = request.method === "GET" || request.method === "HEAD" ? Buffer.alloc(0) : await requestBody(request); let requestedModel: string | undefined; let jsonBody: JsonObject | undefined; if (body.length && request.headers["content-type"]?.includes("application/json")) { jsonBody = asObject(JSON.parse(body.toString("utf8"))); requestedModel = asString(jsonBody.model); } const active = this.registry.activeModelId ? this.registry.models.find((item) => item.id === this.registry.activeModelId) : undefined; if (!active || active.compatibility !== "tool-compatible" || active.compatibilityKey !== this.compatibilityKey(active)) { this.reply(response, 409, { error: { message: "No verified Agent K local model is active" } }); return; } if (!requestedModel) { this.reply(response, 400, { error: { message: "A current local model ID is required" } }); return; } if (requestedModel !== active.id) { this.reply(response, 409, { error: { message: `Local model ${requestedModel} is not active` } }); return; } if (jsonBody) { jsonBody = applyLocalModelReasoningPolicy(jsonBody, active.config.reasoning); body = Buffer.from(JSON.stringify(jsonBody), "utf8"); } if (!this.server || this.runningModelId !== active.id) await this.startModel(active, false); const upstream = await this.internalFetch(request.url ?? "/", { method: request.method, headers: sanitizeHeaders(request.headers), body: body.length ? new Uint8Array(body) : undefined, redirect: "manual", signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(10 * 60_000)]) }); const upstreamHeaders: Record<string, string> = {}; upstream.headers.forEach((value, name) => { if (!["content-encoding", "transfer-encoding", "connection"].includes(name.toLowerCase())) upstreamHeaders[name] = value; }); response.writeHead(upstream.status, upstreamHeaders); if (!upstream.body) { response.end(); return; } for await (const chunk of webStreamChunks(upstream.body)) if (!response.write(Buffer.from(chunk))) await new Promise<void>((resolveDrain) => response.once("drain", resolveDrain)); response.end(); } catch (cause) { if (!response.headersSent) this.reply(response, 502, { error: { message: errorMessage(cause) } }); else response.destroy(cause instanceof Error ? cause : undefined); } }
  private reply(response: ServerResponse, status: number, body: JsonObject): void { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }

  private async assertProviderOwnership(): Promise<void> { const path = join(piAgentDirectory(), "models.json"); const root = asObject(await readJson(path, {})); const existing = asObject(asObject(root.providers)[LOCAL_MODEL_PROVIDER_ID]); if (Object.keys(existing).length && existing.agentKManaged !== true) { this.providerConflict = `Provider ${LOCAL_MODEL_PROVIDER_ID} already exists and is not managed by Agent K`; throw new Error(this.providerConflict); } this.providerConflict = undefined; }
  private async syncProvider(): Promise<void> { const directory = piAgentDirectory(); await mkdir(directory, { recursive: true }); const path = join(directory, "models.json"); const root = asObject(await readJson(path, {})); const providers = asObject(root.providers); const existing = asObject(providers[LOCAL_MODEL_PROVIDER_ID]); if (Object.keys(existing).length && existing.agentKManaged !== true) { this.providerConflict = `Provider ${LOCAL_MODEL_PROVIDER_ID} already exists and is not managed by Agent K`; if (this.registry.activeModelId) throw new Error(this.providerConflict); return; } this.providerConflict = undefined; const active = this.registry.activeModelId ? this.registry.models.find((model) => model.id === this.registry.activeModelId) : undefined; if (active && active.compatibility === "tool-compatible" && active.compatibilityKey === this.compatibilityKey(active)) providers[LOCAL_MODEL_PROVIDER_ID] = { name: "Agent K llama.cpp", baseUrl: `http://127.0.0.1:${this.proxyPort}/v1`, api: "openai-completions", apiKey: this.proxyToken, agentKManaged: true, models: [{ id: active.id, name: active.name, contextWindow: active.config.contextSize, maxTokens: active.config.maxOutputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, input: ["text"], reasoning: active.config.reasoning, ...(active.config.reasoning ? { thinkingLevelMap: { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null } } : {}), compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "qwen-chat-template" } }] }; else delete providers[LOCAL_MODEL_PROVIDER_ID]; root.providers = providers; await atomicWrite(path, JSON.stringify(root, null, 2), true); }
}

async function randomPort(): Promise<number> { const server = createServer(); await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", () => resolveListen()); }); const address = server.address(); if (!address || typeof address === "string") throw new Error("Unable to allocate a local port"); const port = address.port; await new Promise<void>((resolveClose) => server.close(() => resolveClose())); return port; }

async function findExecutable(root: string): Promise<string | undefined> { try { const pending = [root]; while (pending.length) { const directory = pending.shift() as string; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) pending.push(path); else if (entry.name === (process.platform === "win32" ? "llama-server.exe" : "llama-server")) return path; } } } catch { /* Runtime not provisioned. */ } return undefined; }

async function findLibraryDirectories(root: string): Promise<string[]> {
  const directories = new Set<string>();
  try {
    const pending = [root];
    while (pending.length) {
      const directory = pending.shift() as string;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (/\.so(?:\.|$)/.test(entry.name)) directories.add(directory);
      }
    }
  } catch { /* Runtime not provisioned. */ }
  return [...directories];
}

async function extractTar(archive: string, destination: string): Promise<void> { await new Promise<void>((resolveExtract, rejectExtract) => { const child = spawn("tar", ["-xzf", archive, "-C", destination], { windowsHide: true, stdio: "ignore" }); child.once("error", rejectExtract); child.once("exit", (code) => code === 0 ? resolveExtract() : rejectExtract(new Error(`tar exited with code ${code}`))); }); }

async function statfsAvailable(path: string): Promise<number | undefined> { try { const { statfs } = await import("node:fs/promises"); const value = await statfs(path); return Number(value.bavail) * Number(value.bsize); } catch { return undefined; } }

async function remoteFileSize(url: string): Promise<number> {
  const readLength = (response: Response): number => {
    const range = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "")?.[1];
    const value = Number(range ?? response.headers.get("content-length"));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (head.ok) { const size = readLength(head); if (size) return size; }
  } catch { /* Some hubs do not implement HEAD; use a one-byte range probe. */ }
  const probe = await fetch(url, { headers: { Range: "bytes=0-0" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  const size = readLength(probe); await probe.body?.cancel();
  if (!(probe.ok || probe.status === 206) || !size) throw new Error("Remote GGUF size is unavailable; disk space cannot be checked safely");
  return size;
}

async function* webStreamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try { for (;;) { const result = await reader.read(); if (result.done) return; yield result.value; } }
  finally { reader.releaseLock(); }
}
