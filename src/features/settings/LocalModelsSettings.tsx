import { useEffect, useMemo, useRef, useState } from "react";
import {
  desktop,
  type HubGgufFile,
  type HubModelResult,
  type LocalModelRecord,
  type LocalModelKvCacheType,
  type LocalModelRuntimeConfig,
  type LocalModelSnapshot,
  type LocalModelSource,
} from "../../lib/desktop";
import { platform } from "../../lib/platform";
import { useSettings } from "./SettingsContext";

const statusText: Record<string, [string, string]> = {
  queued: ["排队中", "Queued"], downloading: ["下载中", "Downloading"], paused: ["已暂停", "Paused"],
  "verifying-download": ["校验下载", "Checking download"], ready: ["已下载", "Downloaded"], provisioning: ["准备运行时", "Provisioning runtime"],
  loading: ["加载中", "Loading"], "verifying-tools": ["验证工具调用", "Verifying tools"], running: ["运行中", "Running"],
  stopping: ["停止中", "Stopping"], failed: ["失败", "Failed"], missing: ["文件缺失", "Missing"],
};

const kvCacheTypes: LocalModelKvCacheType[] = ["f32", "f16", "bf16", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0", "iq4_nl"];

function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value; let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function localModelError(cause: unknown, en: boolean): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (/Wait for all Pi runtimes to become idle before switching the local model/i.test(raw)) return en ? "Wait for the current Pi response, tool execution, or interaction to finish before switching the local model." : "当前 Pi 正在生成回复、执行工具或等待交互，请完成后再切换本地模型。";
  if (/Wait for all Pi runtimes to become idle before deleting the active model/i.test(raw)) return en ? "Wait for the current Pi response or tool execution to finish before deleting the active model." : "当前 Pi 正在生成回复或执行工具，请等待任务结束后再删除当前模型。";
  return raw.replace(/^Error invoking remote method ['"]agent-k:invoke['"]:\s*Error:\s*/i, "");
}

function RuntimeDownloadCard({ snapshot, en }: { snapshot: LocalModelSnapshot; en: boolean }) {
  const progress = snapshot.runtimeDownload;
  if (!progress) return null;
  const percent = progress.totalBytes > 0 ? Math.min(100, progress.completedBytes / progress.totalBytes * 100) : 0;
  const phase = progress.phase === "downloading" ? (en ? "Downloading runtime" : "正在下载运行时") : progress.phase === "verifying" ? (en ? "Verifying SHA-256" : "正在校验 SHA-256") : (en ? "Extracting runtime" : "正在解压运行时");
  return <div aria-live="polite" className="local-runtime-progress">
    <header><span><i className="fa-solid fa-download" /><strong>{phase}</strong></span><b>{progress.totalBytes > 0 ? `${percent.toFixed(1)}%` : "—"}</b></header>
    <div className="local-runtime-progress-track"><i style={{ width: `${percent}%` }} /></div>
    <div className="local-runtime-progress-details"><span title={progress.fileName}>{progress.fileName}</span><span>{progress.backend} · {progress.source}</span><span>{bytes(progress.completedBytes)} / {bytes(progress.totalBytes)}{progress.phase === "downloading" && progress.bytesPerSecond > 0 ? ` · ${bytes(progress.bytesPerSecond)}/s` : ""}</span></div>
  </div>;
}

function ModelCard({ model, snapshot, en, act }: { model: LocalModelRecord; snapshot: LocalModelSnapshot; en: boolean; act(action: () => Promise<unknown>): void }) {
  const [advanced, setAdvanced] = useState(false);
  const [config, setConfig] = useState(model.config);
  const [cudaConsent, setCudaConsent] = useState<{ run: () => Promise<unknown> }>();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  useEffect(() => setConfig(model.config), [model.config]);
  useEffect(() => {
    if (!deleteConfirm) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeleteConfirm(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deleteConfirm]);
  const active = snapshot.activeModelId === model.id;
  const serverActive = snapshot.runningModelId === model.id;
  const runtimePreparing = snapshot.runtimeDownload?.modelId === model.id;
  const deleteBlocked = active && snapshot.piBusy;
  const verificationPhase = snapshot.verificationStage?.modelId === model.id ? snapshot.verificationStage.phase : undefined;
  const verificationText = verificationPhase ? ({
    "preparing-runtime": en ? "Checking private runtime…" : "正在检查私有运行时…",
    "loading-model": en ? "Loading the model…" : "正在加载模型…",
    "checking-template": en ? "Checking the chat template…" : "正在检查对话模板…",
    "requesting-tool-call": en ? "Testing a forced tool call…" : "正在测试强制工具调用…",
    "checking-tool-result": en ? "Testing the tool-result response…" : "正在测试工具结果续答…",
    "checking-vision": en ? "Testing image input…" : "正在测试图片输入…",
  }[verificationPhase]) : undefined;
  const compatible = model.compatibility === "tool-compatible";
  const supportsVision = model.files.some((file) => file.kind === "mmproj");
  const linuxCudaAvailable = snapshot.hardware.platform === "linux" && snapshot.hardware.availableBackends.includes("cuda12");
  const usesThirdPartyCuda = linuxCudaAvailable && (model.config.backend === "auto" || model.config.backend === "cuda12");
  const supportedBackends: LocalModelRuntimeConfig["backend"][] = snapshot.hardware.platform === "darwin"
    ? ["auto", "metal", "cpu"]
    : snapshot.hardware.platform === "win32"
      ? ["auto", "cpu", "vulkan", "cuda12", "cuda13"]
      : ["auto", ...(linuxCudaAvailable ? ["cuda12" as const] : []), "cpu", "vulkan", "rocm"];
  const compatibility = model.compatibility === "tool-compatible" ? (en ? "Tool protocol compatible" : "工具协议兼容") : model.compatibility === "tool-incompatible" ? (en ? "Tool protocol incompatible" : "工具协议不兼容") : model.compatibility === "verifying-tools" ? (en ? "Verifying tool protocol" : "正在验证工具协议") : (en ? "Pending verification" : "待验证");
  const setNumber = (key: keyof LocalModelRuntimeConfig, value: string) => setConfig((current) => ({ ...current, [key]: Number(value) }));
  const hasThirdPartyCudaConsent = () => {
    if (!usesThirdPartyCuda) return true;
    const consentKey = "agent-k-third-party-runtime:ai-dock/llama.cpp-cuda:b10182";
    return window.localStorage.getItem(consentKey) === "accepted";
  };
  const guardedAct = (action: () => Promise<unknown>) => {
    if (hasThirdPartyCudaConsent()) act(action);
    else setCudaConsent({ run: action });
  };
  const acceptCudaConsent = () => {
    const pending = cudaConsent;
    if (!pending) return;
    window.localStorage.setItem("agent-k-third-party-runtime:ai-dock/llama.cpp-cuda:b10182", "accepted");
    setCudaConsent(undefined);
    act(pending.run);
  };
  return <article className={`local-model-card${active ? " is-active" : ""}`}>
    <header>
      <span><strong>{model.name}</strong><small>{model.source}{model.repository ? ` · ${model.repository}` : ""} · {bytes(model.size)}{model.quantization ? ` · ${model.quantization}` : ""}</small></span>
      <span className="local-model-badges">{active && <b>{en ? "Current" : "当前"}</b>}{supportsVision && <i className="is-compatible"><span className="fa-solid fa-image" /> {en ? "Vision" : "视觉"}</i>}<i>{runtimePreparing ? (en ? "Preparing runtime" : "准备运行时") : (statusText[model.status] ?? [model.status, model.status])[en ? 1 : 0]}</i><i className={compatible ? "is-compatible" : model.compatibility === "tool-incompatible" ? "is-incompatible" : ""}>{compatibility}</i></span>
    </header>
    {runtimePreparing && <RuntimeDownloadCard en={en} snapshot={snapshot} />}
    {!runtimePreparing && verificationText && <div aria-live="polite" className="local-model-verification-stage"><i className="fa-solid fa-spinner fa-spin" /><span>{verificationText}</span></div>}
    {(model.compatibilityError || model.error) && <p className="local-model-error">{model.compatibilityError ?? model.error}</p>}
    <div className="local-model-actions">
      <button disabled={model.status === "verifying-tools"} onClick={() => guardedAct(() => desktop.verifyLocalModel(model.id))} type="button"><i className="fa-solid fa-flask" /> {compatible ? (en ? "Reverify" : "重新验证") : (en ? "Verify tools" : "验证工具")}</button>
      <button disabled={!compatible || active} onClick={() => guardedAct(() => desktop.activateLocalModel(model.id))} type="button"><i className="fa-solid fa-circle-check" /> {en ? "Set current" : "设为当前"}</button>
      {serverActive ? <button disabled={snapshot.piBusy} onClick={() => act(() => desktop.stopLocalModel())} title={snapshot.piBusy ? (en ? "Stop Pi before unloading the local model" : "请先停止 Pi，再卸载本地模型") : undefined} type="button"><i className="fa-solid fa-stop" /> {en ? "Stop" : "停止"}</button> : <button disabled={!active || !compatible} onClick={() => act(() => desktop.runLocalModel(model.id))} type="button"><i className="fa-solid fa-play" /> {en ? "Run" : "运行"}</button>}
      {model.status === "failed" && model.config.backend !== "cpu" && <button onClick={() => act(async () => { await desktop.updateLocalModel(model.id, { backend: "cpu" }); await desktop.verifyLocalModel(model.id); })} type="button"><i className="fa-solid fa-microchip" /> {en ? "Retry with CPU" : "使用 CPU 重试"}</button>}
      <button aria-expanded={advanced} className={advanced ? "is-expanded" : undefined} onClick={() => setAdvanced((value) => !value)} type="button">
        <i className={`fa-solid ${advanced ? "fa-chevron-up" : "fa-sliders"}`} /> {advanced ? (en ? "Collapse" : "收起") : (en ? "Advanced" : "高级")}
      </button>
      <button aria-label={en ? `Delete ${model.name}` : `删除 ${model.name}`} className="danger-button" disabled={deleteBlocked} onClick={() => setDeleteConfirm(true)} title={deleteBlocked ? (en ? "Wait for the active Pi task to finish" : "请等待当前 Pi 任务结束") : (en ? `Delete ${model.name}` : `删除 ${model.name}`)} type="button"><i className="fa-solid fa-trash" /></button>
    </div>
    {deleteBlocked && <small className="local-model-busy-note"><i className="fa-solid fa-circle-info" /> {en ? "The active model cannot be deleted while Pi is generating or executing a tool." : "Pi 正在生成或执行工具，当前模型暂时不能删除。"}</small>}
    {advanced && <div className="local-model-advanced">
      <div className="local-model-advanced-fields">
      <label>{en ? "Backend" : "后端"}<select value={config.backend} onChange={(event) => setConfig({ ...config, backend: event.target.value as LocalModelRuntimeConfig["backend"] })}>{supportedBackends.map((backend) => {
        const detected = backend === "auto" || snapshot.hardware.availableBackends.includes(backend);
        const name = backend === "cuda12" && snapshot.hardware.platform === "linux" ? (en ? "CUDA 12.8 (ai-dock, third-party)" : "CUDA 12.8（ai-dock 第三方）") : backend;
        return <option key={backend} value={backend}>{name}{detected ? "" : (en ? " (not detected)" : "（未检测到）")}</option>;
      })}</select></label>
      <label>{en ? `Context (tokens${model.trainingContext ? ` · trained ${model.trainingContext.toLocaleString()}` : ""})` : `上下文（tokens${model.trainingContext ? ` · 训练值 ${model.trainingContext.toLocaleString()}` : ""}）`}<input className="local-model-context-input" max="1048576" min="512" step="512" type="number" value={config.contextSize} onChange={(event) => setNumber("contextSize", event.target.value)} /></label>
      <label>{en ? "GPU layers (-1 auto)" : "GPU 层（-1 自动）"}<input max="10000" min="-1" type="number" value={config.gpuLayers} onChange={(event) => setNumber("gpuLayers", event.target.value)} /></label>
      <label>{en ? "Threads (0 auto)" : "线程（0 自动）"}<input max="512" min="0" type="number" value={config.threads} onChange={(event) => setNumber("threads", event.target.value)} /></label>
      <label title={en ? "Data type used by the key side of the KV cache. Lower-bit types use less memory but can reduce quality." : "KV cache 中 Key 缓存的数据类型。低位量化可减少内存占用，但可能降低质量。"}>{en ? "K cache type" : "K 缓存类型"}<select className="local-model-cache-type-k" value={config.cacheTypeK} onChange={(event) => setConfig({ ...config, cacheTypeK: event.target.value as LocalModelKvCacheType })}>{kvCacheTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
      <label title={en ? "Data type used by the value side of the KV cache. Lower-bit types use less memory but can reduce quality." : "KV cache 中 Value 缓存的数据类型。低位量化可减少内存占用，但可能降低质量。"}>{en ? "V cache type" : "V 缓存类型"}<select className="local-model-cache-type-v" value={config.cacheTypeV} onChange={(event) => setConfig({ ...config, cacheTypeV: event.target.value as LocalModelKvCacheType })}>{kvCacheTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
      <label>{en ? "Max output" : "最大输出"}<input max="65536" min="64" type="number" value={config.maxOutputTokens} onChange={(event) => setNumber("maxOutputTokens", event.target.value)} /></label>
      <label title={en ? "When enabled, conversations can switch this model between Off and High reasoning." : "启用后，可在对话中为该模型切换关闭或高推理。"}><span>{en ? "Reasoning controls" : "推理控制"}</span><span className="local-model-check"><input checked={config.reasoning} onChange={(event) => setConfig({ ...config, reasoning: event.target.checked })} type="checkbox" /> {en ? "Available in chat" : "允许对话控制"}</span></label>
      </div>
      {linuxCudaAvailable && <p className="local-model-backend-note is-warning"><i className="fa-solid fa-triangle-exclamation" /> {en ? "Linux CUDA uses the pinned third-party ai-dock CUDA 12.8 build plus private NVIDIA runtime libraries (~760 MiB). Agent K verifies every file before extraction and does not modify the host environment." : "Linux CUDA 使用固定版本的第三方 ai-dock CUDA 12.8 构建，并下载约 760 MiB 的私有 NVIDIA 运行库。Agent K 会逐个校验文件，且不修改宿主环境。"}</p>}
      <div className="local-model-advanced-footer"><button onClick={() => act(() => desktop.updateLocalModel(model.id, config))} type="button">{en ? "Apply settings" : "应用设置"}</button></div>
    </div>}
    {cudaConsent && <div className="local-runtime-consent-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCudaConsent(undefined); }}>
      <div aria-labelledby={`local-runtime-consent-title-${model.id}`} aria-modal="true" className="local-runtime-consent" role="dialog">
        <header><i className="fa-solid fa-triangle-exclamation" /><span><strong id={`local-runtime-consent-title-${model.id}`}>{en ? "Third-party CUDA runtime" : "第三方 CUDA 运行时"}</strong><small>ai-dock/llama.cpp-cuda · b10182 · CUDA 12.8</small></span></header>
        <p>{en ? "Upstream llama.cpp does not publish a Linux CUDA binary. Agent K will download the pinned ai-dock build and about 760 MiB of official NVIDIA CUDA Runtime, cuBLAS, and NCCL libraries into its private runtime directory. Every file is SHA-256 verified; the host environment is not modified." : "上游 llama.cpp 没有发布 Linux CUDA 二进制。Agent K 将下载固定版本的 ai-dock 构建，以及约 760 MiB 的 NVIDIA 官方 CUDA Runtime、cuBLAS 和 NCCL 运行库，全部存入私有运行时目录。每个文件都会校验 SHA-256，不会修改宿主环境。"}</p>
        <code>5576a132d768b240b1c3e950e71b456cbf7b90c6a38dca2fcd93f965b32098c9</code>
        <footer><button onClick={() => setCudaConsent(undefined)} type="button">{en ? "Cancel" : "取消"}</button><button className="is-primary" onClick={acceptCudaConsent} type="button">{en ? "Accept and continue" : "接受并继续"}</button></footer>
      </div>
    </div>}
    {deleteConfirm && <div className="local-runtime-consent-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteConfirm(false); }}>
      <div aria-labelledby={`local-model-delete-title-${model.id}`} aria-modal="true" className="local-runtime-consent local-model-delete-confirm" role="dialog">
        <header><i className="fa-solid fa-trash-can" /><span><strong id={`local-model-delete-title-${model.id}`}>{en ? "Delete local model" : "删除本地模型"}</strong><small>{model.name}</small></span></header>
        <p>{en ? "The model files and their managed configuration will be removed from Agent K. This action cannot be undone." : "将从 Agent K 中移除该模型文件及其托管配置，此操作无法撤销。"}</p>
        <footer><button onClick={() => setDeleteConfirm(false)} type="button">{en ? "Cancel" : "取消"}</button><button autoFocus className="is-danger" onClick={() => { setDeleteConfirm(false); act(() => desktop.deleteLocalModel(model.id)); }} type="button">{en ? "Delete" : "删除"}</button></footer>
      </div>
    </div>}
  </article>;
}

export function LocalModelsSettings() {
  const { settings, update } = useSettings();
  const en = settings.locale === "en-US";
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot>();
  const [expanded, setExpanded] = useState(false);
  const [source, setSource] = useState<Exclude<LocalModelSource, "import">>("huggingface");
  const [query, setQuery] = useState("");
  const [repository, setRepository] = useState("");
  const [results, setResults] = useState<HubModelResult[]>([]);
  const [files, setFiles] = useState<HubGgufFile[]>([]);
  const [inspectionFeedback, setInspectionFeedback] = useState<{ kind: "checking" | "success" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [storageNotice, setStorageNotice] = useState<string>();
  const [highlightedDownloadIds, setHighlightedDownloadIds] = useState<ReadonlySet<string>>(() => new Set());
  const downloadHighlightTimers = useRef(new Map<string, number>());
  const refreshGeneration = useRef(0);
  const configuredStoragePath = settings.localModelDirectory || snapshot?.defaultStoragePath || "";
  const refresh = async () => {
    const generation = ++refreshGeneration.current;
    const next = await desktop.localModels();
    if (generation === refreshGeneration.current) setSnapshot(next);
    return next;
  };
  const act = (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    void action().then(refresh).catch((cause) => setError(localModelError(cause, en))).finally(() => setBusy(false));
  };
  const modelAct = (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    void action().then(async () => {
      await refresh();
      window.dispatchEvent(new Event("agent-k-model-catalog-changed"));
      window.dispatchEvent(new Event("agent-k-model-changed"));
    }).catch((cause) => setError(localModelError(cause, en))).finally(() => setBusy(false));
  };
  useEffect(() => { void refresh().catch((cause) => setError(localModelError(cause, en))); const stop = desktop.onEvent((event) => { if (event.type === "local_models_changed" || event.type === "agent_start" || event.type === "agent_settled") void refresh().catch(() => undefined); }); return () => { refreshGeneration.current += 1; stop(); }; }, [en]);
  useEffect(() => { if (!logsOpen) return; void desktop.localModelLogs().then(setLogs); const timer = window.setInterval(() => void desktop.localModelLogs().then(setLogs), 1500); return () => window.clearInterval(timer); }, [logsOpen]);
  useEffect(() => () => { for (const timer of downloadHighlightTimers.current.values()) window.clearTimeout(timer); }, []);
  const groups = useMemo(() => files.filter((file) => file.kind === "model" && file.shardIndex === 1), [files]);
  const highlightDownload = (id: string) => {
    const previousTimer = downloadHighlightTimers.current.get(id);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    setHighlightedDownloadIds((current) => new Set(current).add(id));
    downloadHighlightTimers.current.set(id, window.setTimeout(() => {
      downloadHighlightTimers.current.delete(id);
      setHighlightedDownloadIds((current) => { const next = new Set(current); next.delete(id); return next; });
    }, 2400));
  };
  const downloadModel = (file: string) => {
    setBusy(true); setError(undefined);
    void desktop.downloadLocalModel(source, repository, file).then(async (id) => {
      highlightDownload(id);
      await refresh();
    }).catch((cause) => setError(localModelError(cause, en))).finally(() => setBusy(false));
  };
  const search = () => act(async () => { const found = await desktop.searchLocalModels(source, query); setResults(found); });
  const inspect = (value = repository) => act(async () => {
    setInspectionFeedback({ kind: "checking", text: en ? "Checking repository…" : "正在检查仓库…" });
    try {
      const checked = await desktop.inspectLocalModelRepository(source, value);
      setRepository(checked.repository); setFiles(checked.files);
      if (!checked.downloadable) throw new Error(checked.reason);
      const modelCount = checked.files.filter((file) => file.kind === "model").length;
      const projectorCount = checked.files.filter((file) => file.kind === "mmproj").length;
      setInspectionFeedback(modelCount
        ? { kind: "success", text: en ? `Found ${modelCount} model GGUF file${modelCount === 1 ? "" : "s"}${projectorCount ? ` and ${projectorCount} vision projector${projectorCount === 1 ? "" : "s"}` : ""}.` : `已找到 ${modelCount} 个模型 GGUF${projectorCount ? `，以及 ${projectorCount} 个视觉投影文件` : ""}。` }
        : { kind: "error", text: en ? "No downloadable GGUF files were found in this repository." : "该仓库中没有可下载的 GGUF 文件。" });
    } catch (cause) {
      setFiles([]);
      setInspectionFeedback({ kind: "error", text: String(cause instanceof Error ? cause.message : cause) });
      throw cause;
    }
  });
  const importModel = async () => {
    const selected = await platform.openDialog({ title: en ? "Import GGUF model" : "导入 GGUF 模型", filters: [{ name: "GGUF", extensions: ["gguf"] }] });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (path) act(() => desktop.importLocalModel(path));
  };
  const toggleManagedModels = async () => {
    if (!snapshot || busy) return;
    const enabled = !snapshot.enabled;
    setBusy(true);
    setError(undefined);
    try {
      await desktop.setLocalModelsEnabled(enabled);
      const next = await refresh();
      if (!next.enabled) setExpanded(false);
      window.dispatchEvent(new Event("agent-k-model-catalog-changed"));
      window.dispatchEvent(new Event("agent-k-model-changed"));
    } catch (cause) {
      setError(localModelError(cause, en));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const chooseStorage = async () => {
    const selected = await platform.openDialog({ directory: true, title: en ? "Select local model storage" : "选择本地模型保存位置" });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;
    try {
      const validated = await desktop.validateCacheDirectory(path);
      await update({ localModelDirectory: validated });
      setStorageNotice(en ? "Saved. Restart Agent K to use the new location. Existing model data will not be moved or deleted." : "已保存。重启 Agent K 后使用新位置；旧模型数据不会被移动或删除。");
    } catch (cause) { setError(String(cause)); }
  };
  const resetStorage = async () => {
    await update({ localModelDirectory: "" });
    setStorageNotice(en ? "The default location will be restored after restarting Agent K. Existing model data will not be moved or deleted." : "重启 Agent K 后恢复默认位置；旧模型数据不会被移动或删除。");
  };
  if (!snapshot) return <section className="settings-section local-model-section"><h3>{en ? "Managed local models" : "托管本地模型"}</h3><p>{error ?? (en ? "Loading…" : "加载中…")}</p></section>;
  const runtimeSupported = snapshot.hardware.platform === "darwin"
    ? snapshot.hardware.architecture === "arm64" || snapshot.hardware.architecture === "x64"
    : (snapshot.hardware.platform === "linux" || snapshot.hardware.platform === "win32") && snapshot.hardware.architecture === "x64";
  const disableBlocked = snapshot.enabled && Boolean(snapshot.runningModelId) && snapshot.piBusy;
  return <section className="settings-section local-model-section" aria-busy={busy}>
    <div className="local-model-heading"><span className="local-model-heading-copy"><h3>{en ? "Managed local models" : "托管本地模型"}</h3><p>{runtimeSupported ? (en ? "GGUF models run privately with llama.cpp. Matching vision projectors are paired automatically and verified with a real image request." : "GGUF 模型使用 llama.cpp 私有运行；匹配的视觉投影文件会自动配对，并通过真实图片请求验证。") : (en ? "Managed local models require Windows x64, Linux x64, or macOS on Apple Silicon/Intel." : "托管本地模型需要 Windows x64、Linux x64，或 Apple Silicon/Intel Mac。")}</p></span><div className="local-model-heading-controls">{snapshot.enabled && expanded && <><button onClick={() => void importModel()} type="button"><i className="fa-solid fa-file-import" /> {en ? "Import GGUF" : "导入 GGUF"}</button><button onClick={() => setLogsOpen((value) => !value)} type="button"><i className="fa-solid fa-terminal" /> {en ? "Logs" : "日志"}</button></>}<button aria-checked={snapshot.enabled} aria-label={en ? "Enable managed local models" : "启用托管本地模型"} className={snapshot.enabled ? "resource-toggle is-active" : "resource-toggle"} disabled={disableBlocked || !runtimeSupported} onClick={() => void toggleManagedModels()} role="switch" title={!runtimeSupported ? (en ? "Managed local models require Windows x64, Linux x64, or macOS on Apple Silicon/Intel" : "托管本地模型需要 Windows x64、Linux x64，或 Apple Silicon/Intel Mac") : disableBlocked ? (en ? "Stop Pi before disabling managed local models" : "请先停止 Pi，再禁用托管本地模型") : undefined} type="button"><span /></button>{snapshot.enabled && <button aria-controls="local-model-settings-content" aria-expanded={expanded} aria-label={expanded ? (en ? "Collapse managed local models" : "收起托管本地模型") : (en ? "Expand managed local models" : "展开托管本地模型")} className="local-model-expand-button" onClick={() => setExpanded((value) => !value)} type="button"><i className={`fa-solid fa-chevron-${expanded ? "down" : "right"}`} /></button>}</div></div>
    {snapshot.enabled && expanded && <div className="local-model-content" id="local-model-settings-content">
      <div className="local-model-hardware"><i className="fa-solid fa-microchip" /><span>{snapshot.hardware.platform} {snapshot.hardware.architecture} · {snapshot.hardware.gpu ?? (en ? "CPU" : "CPU")} · {snapshot.hardware.availableBackends.join(" / ")}</span></div>
      <div className="local-model-storage">
        <label htmlFor="local-model-storage-path">{en ? "Model storage location" : "模型保存位置"}</label>
        <p>{en ? "Stores GGUF models, resumable downloads, and the private llama.cpp runtime. Changes apply after restarting Agent K; existing data is not migrated." : "保存 GGUF 模型、断点下载和私有 llama.cpp 运行时。修改后重启生效，旧数据不会自动迁移。"}</p>
        <div className="inline-field"><input id="local-model-storage-path" readOnly value={configuredStoragePath} /><button onClick={() => void chooseStorage()} type="button">{en ? "Choose" : "选择"}</button>{settings.localModelDirectory && <button onClick={() => void resetStorage()} type="button">{en ? "Use default" : "恢复默认"}</button>}</div>
        <small>{en ? "Current location" : "当前位置"}：{configuredStoragePath}</small>
        {storageNotice && <div aria-live="polite" className="local-model-storage-notice"><i className="fa-solid fa-circle-info" /> {storageNotice}</div>}
      </div>
      {snapshot.providerConflict && <div className="local-model-error"><i className="fa-solid fa-triangle-exclamation" /> {snapshot.providerConflict}</div>}
      {error && <div className="local-model-error"><i className="fa-solid fa-circle-exclamation" /> {error}<button onClick={() => setError(undefined)} type="button">×</button></div>}
      {snapshot.downloads.length > 0 && <div className="local-model-queue"><h4>{en ? "Download queue" : "下载队列"}</h4>{snapshot.downloads.map((task) => { const percent = task.totalBytes ? Math.min(100, task.completedBytes / task.totalBytes * 100) : 0; return <div className={highlightedDownloadIds.has(task.id) ? "is-new" : undefined} key={task.id}><span><strong>{task.repository}</strong><small>{(statusText[task.status] ?? [task.status, task.status])[en ? 1 : 0]} · {percent.toFixed(1)}% · {bytes(task.completedBytes)} / {bytes(task.totalBytes)}{task.status === "downloading" && task.bytesPerSecond ? ` · ${bytes(task.bytesPerSecond)}/s` : ""}</small><i><b style={{ width: `${percent}%` }} /></i>{task.error && <em>{task.error}</em>}</span><div>{(task.status === "downloading" || task.status === "queued") && <button aria-label={en ? "Pause download" : "暂停下载"} onClick={() => act(() => desktop.pauseLocalModelDownload(task.id))} type="button"><i className="fa-solid fa-pause" /></button>}{(task.status === "paused" || task.status === "failed") && <button aria-label={en ? "Resume download" : "继续下载"} onClick={() => act(() => desktop.resumeLocalModelDownload(task.id))} type="button"><i className="fa-solid fa-play" /></button>}<button aria-label={en ? "Cancel download" : "取消下载"} onClick={() => act(() => desktop.cancelLocalModelDownload(task.id))} type="button"><i className="fa-solid fa-xmark" /></button></div></div>; })}</div>}
      <div className="local-model-discovery">
      <div className="segmented-control"><button className={source === "huggingface" ? "is-active" : ""} onClick={() => { setSource("huggingface"); setFiles([]); setInspectionFeedback(undefined); }} type="button">Hugging Face</button><button className={source === "modelscope" ? "is-active" : ""} onClick={() => { setSource("modelscope"); setFiles([]); setInspectionFeedback(undefined); }} type="button">ModelScope</button></div>
      <div className="inline-field"><input onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") search(); }} placeholder={en ? "Search public GGUF repositories" : "搜索公开 GGUF 仓库"} value={query} /><button disabled={busy || !query.trim()} onClick={search} type="button"><i className="fa-solid fa-magnifying-glass" /> {en ? "Search" : "搜索"}</button></div>
      <div className="inline-field"><input onChange={(event) => { setRepository(event.target.value); setInspectionFeedback(undefined); setFiles([]); }} onKeyDown={(event) => { if (event.key === "Enter") inspect(); }} placeholder={en ? "owner/repo or official repository URL" : "owner/repo 或官方仓库链接"} value={repository} /><button disabled={busy || !repository.trim()} onClick={() => inspect()} type="button">{inspectionFeedback?.kind === "checking" ? (en ? "Checking…" : "检查中…") : (en ? "Check" : "检查")}</button></div>
      {inspectionFeedback && <div aria-live="polite" className={`local-model-inspection-feedback is-${inspectionFeedback.kind}`}><i className={`fa-solid ${inspectionFeedback.kind === "checking" ? "fa-spinner fa-spin" : inspectionFeedback.kind === "success" ? "fa-circle-check" : "fa-circle-exclamation"}`} /> {inspectionFeedback.text}</div>}
      {results.length > 0 && <div className="local-model-results">{results.map((result) => <button disabled={result.gated || result.private} key={`${result.source}/${result.repository}`} onClick={() => { setRepository(result.repository); inspect(result.repository); }} type="button"><span><strong>{result.name}</strong><small>{result.repository}{result.description ? ` · ${result.description}` : ""}</small></span><i>{result.gated || result.private ? (en ? "Token required" : "需要 Token") : result.downloads ? `${result.downloads.toLocaleString()} ↓` : "GGUF"}</i></button>)}</div>}
      {groups.length > 0 && <div className="local-model-files">{groups.map((file) => <div key={file.group}><span><strong>{file.group}</strong><small>{file.shardCount > 1 ? `${file.shardCount} shards` : bytes(file.size)}{file.sha256 ? " · SHA-256" : ""}{files.some((candidate) => candidate.kind === "mmproj") ? (en ? " · vision projector auto-included" : " · 自动包含视觉投影文件") : ""}</small></span><button onClick={() => downloadModel(file.name)} type="button"><i className="fa-solid fa-download" /> {en ? "Download" : "下载"}</button></div>)}</div>}
      </div>
      <div className="local-model-list">{snapshot.models.length ? snapshot.models.map((model) => <ModelCard act={modelAct} en={en} key={model.id} model={model} snapshot={snapshot} />) : <p className="empty-settings">{en ? "No managed local models yet." : "尚未添加托管本地模型。"}</p>}</div>
      {logsOpen && <div className="local-model-logs"><header><strong>llama.cpp</strong><button onClick={() => setLogsOpen(false)} type="button">×</button></header><pre>{logs.join("\n") || (en ? "No runtime logs." : "暂无运行日志。")}</pre></div>}
    </div>}
  </section>;
}
