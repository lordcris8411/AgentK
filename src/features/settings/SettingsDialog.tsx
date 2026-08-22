import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  desktop,
  type BrowserOption,
  type FileFormatPluginResource,
  type LanguagePack,
  type ProviderCatalogItem,
  type ProviderDraft,
  type ProviderModelDraft,
  type PiResource,
  type PiResourceChange,
  type RuntimeInfo,
  type SkillHubPreview,
  type SkillHubScope,
  type ThinkingLevel,
} from "../../lib/desktop";
import { useSettings } from "./SettingsContext";
import { platform } from "../../lib/platform";
import type { ThemeDefinition } from "../../lib/themes";
import { modelIsEnabled, modelKey } from "../../lib/modelAvailability";
import { DirectoryPickerDialog } from "../../components/DirectoryPickerDialog";
import { AgentKLogo } from "../../components/AgentKLogo";
import { LocalModelsSettings } from "./LocalModelsSettings";

export type SettingsPage = "models" | "appearance" | "agentSettings" | "skills" | "extensions" | "editors" | "languagePacks" | "permissions" | "about";

let aboutDataPromise: Promise<[string, RuntimeInfo]> | undefined;
let browserDataPromise: Promise<BrowserOption[]> | undefined;

const featuredSkills = [
  {
    name: "Find Skills",
    description: "Vercel Labs 的技能发现助手",
    sourceUrl: "https://github.com/vercel-labs/skills/tree/main/skills/find-skills",
  },
];

const configurableThinkingLevels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const allThinkingLevels: ThinkingLevel[] = ["off", ...configurableThinkingLevels];

function enabledThinkingLevels(map: Partial<Record<ThinkingLevel, string | null>> | undefined): ThinkingLevel[] {
  return configurableThinkingLevels.filter((level) => typeof map?.[level] === "string");
}

function configuredThinkingLevelMap(levels: ThinkingLevel[]): Partial<Record<ThinkingLevel, string | null>> {
  const selected = new Set(levels);
  return Object.fromEntries(["off", ...configurableThinkingLevels].map((level) => [
    level,
    level === "off" || selected.has(level as ThinkingLevel) ? level : null,
  ])) as Partial<Record<ThinkingLevel, string | null>>;
}

function supportedThinkingLevels(model: ProviderModelDraft | undefined): ThinkingLevel[] {
  if (!model?.reasoning) return ["off"];
  return allThinkingLevels.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function previewStyle(theme: ThemeDefinition): CSSProperties {
  return {
    "--theme-preview-app": theme.colors["surface-app"],
    "--theme-preview-panel": theme.colors["surface-panel"],
    "--theme-preview-raised": theme.colors["surface-raised"],
    "--theme-preview-text": theme.colors["text-primary"],
    "--theme-preview-muted": theme.colors["text-muted"],
    "--theme-preview-accent": theme.colors.accent,
    "--theme-preview-selection": theme.colors["selection-background"],
  } as CSSProperties;
}

function resourceChangeKey(
  resource: PiResource,
  target: PiResourceChange["target"],
): string {
  return `${target}:${resource.kind}:${resource.path}`;
}

function withPendingResourceChanges(
  resources: PiResource[],
  changes: PiResourceChange[],
): PiResource[] {
  const pending = new Map(changes.map((change) => [
    resourceChangeKey(change.resource, change.target),
    change.enabled,
  ]));
  return resources.map((resource) => ({
    ...resource,
    enabled:
      pending.get(resourceChangeKey(resource, "resource")) ?? resource.enabled,
    ...(resource.fileFormat
      ? {
          fileFormat: {
            ...resource.fileFormat,
            enabled:
              pending.get(resourceChangeKey(resource, "file-format")) ??
              resource.fileFormat.enabled,
          },
        }
      : {}),
  }));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function loadAboutData() {
  aboutDataPromise ??= Promise.all([platform.appVersion(), desktop.runtimeInfo()]).catch(
    (error) => {
      aboutDataPromise = undefined;
      throw error;
    },
  );
  return aboutDataPromise;
}

function loadBrowserData() {
  browserDataPromise ??= desktop.listBrowsers().catch((error) => {
    browserDataPromise = undefined;
    throw error;
  });
  return browserDataPromise;
}

export function SettingsDialog({
  open,
  onClose,
  onPageChange,
  initialPage = "models",
  cwd,
  runtimeId,
  sessionId,
}: {
  open: boolean;
  onClose(changes: PiResourceChange[], editorSettingsChanged: boolean): void;
  onPageChange?(page: SettingsPage): void;
  initialPage?: SettingsPage;
  cwd?: string;
  runtimeId?: string;
  sessionId?: string;
}) {
  const { settings, update, t, themes, refreshThemes, resolvedTheme } = useSettings();
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [resources, setResources] = useState<PiResource[]>([]);
  const [resourceChanges, setResourceChanges] = useState<PiResourceChange[]>([]);
  const [resourcesLocked, setResourcesLocked] = useState(false);
  const resourceBaselineRef = useRef(new Map<string, boolean>());
  const editorSettingsBaselineRef = useRef({
    disabledEditors: settings.disabledFileEditors,
    disabledSkills: settings.disabledFileEditorSkills,
  });
  const [disabledFileEditors, setDisabledFileEditors] = useState(
    settings.disabledFileEditors,
  );
  const [disabledFileEditorSkills, setDisabledFileEditorSkills] = useState(
    settings.disabledFileEditorSkills,
  );
  const [firstPartyEditors, setFirstPartyEditors] = useState<
    FileFormatPluginResource[]
  >([]);
  const [languagePacks, setLanguagePacks] = useState<LanguagePack[]>([]);
  const [providers, setProviders] = useState<ProviderCatalogItem[]>([]);
  const [models, setModels] = useState<Array<ProviderModelDraft & { provider: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [poolBusy, setPoolBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [editor, setEditor] = useState<"provider" | "local">();
  const [draft, setDraft] = useState<ProviderDraft>({
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    models: [],
    local: false,
  });
  const [manualModel, setManualModel] = useState("");
  const [manualContextWindow, setManualContextWindow] = useState("");
  const [manualReasoning, setManualReasoning] = useState(false);
  const [manualVision, setManualVision] = useState(false);
  const [manualThinkingLevels, setManualThinkingLevels] = useState<ThinkingLevel[]>([]);
  const [pendingDelete, setPendingDelete] = useState<ProviderCatalogItem>();
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(
    () => new Set(),
  );
  const [skillHubUrl, setSkillHubUrl] = useState("");
  const [skillHubPreview, setSkillHubPreview] = useState<SkillHubPreview>();
  const [skillHubScope, setSkillHubScope] = useState<SkillHubScope>(cwd ? "project" : "user");
  const [extensionPicker, setExtensionPicker] = useState<"editor" | "language" | "theme">();
  const [selectedSkill, setSelectedSkill] = useState<PiResource>();
  const [editorSkillViewer, setEditorSkillViewer] = useState<{ name: string; source: string }>();
  const [authTarget, setAuthTarget] = useState<ProviderCatalogItem>();
  const [authKey, setAuthKey] = useState("");
  const [pendingProviderLogin, setPendingProviderLogin] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [version, setVersion] = useState("0.1.0");
  const [runtimeInfo, setRuntimeInfo] = useState({ piVersion: "unknown", operatingSystem: navigator.platform, architecture: "" });
  const [browsers, setBrowsers] = useState<BrowserOption[]>([
    { id: "default", name: "System default" },
  ]);
  const [cacheDirectoryInfo, setCacheDirectoryInfo] = useState<{ activePath: string; defaultPath: string }>();
  const [themeSlideIndex, setThemeSlideIndex] = useState(0);
  const providersRef = useRef<ProviderCatalogItem[]>([]);
  const editedProviderIdRef = useRef<string | undefined>(undefined);
  const lastCatalogRefreshRef = useRef(0);
  const catalogRefreshGenerationRef = useRef(0);
  const providerLoginPollRef = useRef(false);
  const providerDisplayName = (provider: Pick<ProviderCatalogItem, "id" | "name" | "source">) =>
    provider.source === "builtin" && provider.id === "ollama" ? "Ollama"
      : provider.source === "builtin" && provider.id === "vllm" ? "vLLM"
        : provider.name || provider.id;
  useEffect(() => {
    if (!editor) {
      editedProviderIdRef.current = undefined;
      return;
    }
    editedProviderIdRef.current = providersRef.current.some(
      (provider) => provider.source === "custom" && provider.id === draft.id,
    ) ? draft.id : undefined;
  }, [editor]);
  useEffect(() => {
    const configured = themes.findIndex((theme) => theme.id === settings.theme);
    const selected = configured >= 0
      ? configured
      : themes.findIndex((theme) => theme.id === resolvedTheme);
    if (selected >= 0) setThemeSlideIndex(selected);
  }, [resolvedTheme, settings.theme, themes]);
  const selectThemeSlide = (index: number) => {
    const theme = themes[index];
    if (!theme) return;
    setThemeSlideIndex(index);
    void update({ theme: theme.id });
  };
  const changeThemeSlide = (step: number) => {
    if (!themes.length) return;
    selectThemeSlide((themeSlideIndex + step + themes.length) % themes.length);
  };
  const chooseCacheDirectory = async () => {
    setError(undefined);
    const selected = await platform.openDialog({ directory: true, title: t("cacheDirectoryDialog") });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;
    try {
      const validated = await desktop.validateCacheDirectory(path);
      await update({ cacheDirectory: validated });
      setNotice(t("cacheDirectoryRestart"));
    } catch (cause) {
      setError(String(cause));
    }
  };
  const importTheme = async (path: string) => {
    setError(undefined);
    try {
      const theme = await desktop.importTheme(path);
      await refreshThemes();
      await update({ theme: theme.id });
    } catch (cause) { setError(String(cause)); }
  };
  const removeTheme = async (id: string) => {
    setError(undefined);
    try {
      await desktop.removeTheme(id);
      await refreshThemes();
      if (settings.theme === id) await update({ theme: "light" });
    } catch (cause) { setError(String(cause)); }
  };
  const resetCacheDirectory = async () => {
    setError(undefined);
    try {
      await update({ cacheDirectory: "" });
      setNotice(t("cacheDirectoryRestart"));
    } catch (cause) {
      setError(String(cause));
    }
  };
  const discoverLocal = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const service = await desktop.detectLocalService(draft.baseUrl);
      const found = await desktop.discoverModels(draft.baseUrl, service.kind === "ollama");
      const assessed = await desktop.inferModelReasoning(found.map((model) => model.id));
      const assessmentByModel = new Map(assessed.map((model) => [model.id, model]));
      const enriched = found.map((model) => {
        const assessment = assessmentByModel.get(model.id);
        return {
          ...model,
          ...assessment,
          input: model.input?.includes("image") || assessment?.input?.includes("image")
            ? ["text", "image"] as Array<"text" | "image">
            : ["text"] as Array<"text" | "image">,
        };
      });
      setDraft((current) => ({
        ...current,
        id: editedProviderIdRef.current ? current.id : service.kind === "openai-compatible" ? current.id : service.kind,
        name: editedProviderIdRef.current ? current.name : service.kind === "openai-compatible" ? current.name : service.displayName,
        apiKey: service.kind === "ollama" ? "ollama" : current.apiKey || "local",
        models: enriched,
      }));
      if (enriched[0]) {
        setManualModel(enriched[0].id);
        setManualContextWindow(enriched[0].contextWindow?.toString() ?? "");
        setManualReasoning(enriched[0].reasoning === true);
        setManualVision(enriched[0].input?.includes("image") === true);
        setManualThinkingLevels(enabledThinkingLevels(enriched[0].thinkingLevelMap));
      }
      const verified = enriched.filter((model) => model.reasoning).length;
      const visual = enriched.filter((model) => model.input?.includes("image")).length;
      setNotice(settings.locale === "en-US"
        ? `Checked ${enriched.length} model(s): ${verified} with reasoning controls, ${visual} with image input.`
        : `已检查 ${enriched.length} 个模型：${verified} 个支持推理控制，${visual} 个支持图片输入。`);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const selectManualModel = (model: ProviderModelDraft) => {
    setManualModel(model.id);
    setManualContextWindow(model.contextWindow?.toString() ?? "");
    setManualReasoning(model.reasoning === true);
    setManualVision(model.input?.includes("image") === true);
    setManualThinkingLevels(enabledThinkingLevels(model.thinkingLevelMap));
  };
  const applyProviderCatalog = (catalog: ProviderCatalogItem[]) => {
    providersRef.current = catalog;
    lastCatalogRefreshRef.current = Date.now();
    setProviders(catalog);
    const seen = new Set<string>();
    setModels(catalog.flatMap((provider) => provider.models
      .filter((model) => {
        const key = `${provider.id}/${model.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((model) => ({ ...model, provider: provider.id }))));
  };
  const refresh = async (forceCatalog = true) => {
    const generation = ++catalogRefreshGenerationRef.current;
    setBusy(true);
    setError(undefined);
    try {
      const refreshCatalog = forceCatalog
        || providersRef.current.length === 0
        || Date.now() - lastCatalogRefreshRef.current > 30_000;
      const catalog = refreshCatalog
        ? await desktop.providerCatalog()
        : providersRef.current;
      if (generation !== catalogRefreshGenerationRef.current) return;
      applyProviderCatalog(catalog);
    } catch (cause) {
      if (generation === catalogRefreshGenerationRef.current) setError(String(cause));
    } finally {
      if (generation === catalogRefreshGenerationRef.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!open || page !== "models") return;
    const changed = () => void refresh(true);
    window.addEventListener("agent-k-model-catalog-changed", changed);
    window.addEventListener("agent-k-model-changed", changed);
    return () => {
      window.removeEventListener("agent-k-model-catalog-changed", changed);
      window.removeEventListener("agent-k-model-changed", changed);
    };
  }, [open, page]);
  const reloadModelConfiguration = async () => {
    await desktop.reloadPiRuntimes();
    // Pi reads models.json only on startup. Query the catalog after the pool
    // replacement so a deleted model cannot remain in the selection list.
    await refresh(true);
    window.dispatchEvent(new Event("agent-k-model-changed"));
  };
  const installEditorPlugin = async (sourceDirectory: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const installed = await desktop.installEditorPlugin(sourceDirectory);
      setNotice(`已安装 ${installed.name}${installed.version ? ` v${installed.version}` : ""}`);
      if (cwd && runtimeId) setResources(withPendingResourceChanges(await desktop.piResources(cwd, runtimeId), resourceChanges));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const installLanguagePack = async (sourceDirectory: string) => {
    setBusy(true); setError(undefined);
    try {
      const preview = await desktop.previewLanguagePack(sourceDirectory);
      const permissionSummary = [
        preview.permissions.network ? "网络" : undefined,
        preview.permissions.processes ? "启动进程" : undefined,
        preview.permissions.workspaceWrite ? "写入工作区" : undefined,
        preview.permissions.externalTools.length ? `外部工具：${preview.permissions.externalTools.join(", ")}` : undefined,
      ].filter(Boolean).join("；") || "无额外权限";
      if (!window.confirm(`安装 ${preview.displayName} v${preview.version}？\n权限：${permissionSummary}`)) return;
      const installed = await desktop.installLanguagePack(sourceDirectory, preview.approvalToken); setLanguagePacks(await desktop.listLanguagePacks()); setNotice(`已安装 ${installed.displayName}`);
    }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const viewEditorSkill = async (plugin: Pick<FileFormatPluginResource, "id" | "name">) => {
    if (!cwd) return;
    setBusy(true); setError(undefined);
    try { setEditorSkillViewer({ name: plugin.name, source: await desktop.editorPluginSkill(cwd, plugin.id) }); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const toggleLanguagePlugin = async (id: string) => {
    const current = settings.disabledLanguagePacks; const disabled = !current.includes(id);
    const next = disabled ? [...current, id] : current.filter((value) => value !== id);
    setBusy(true); setError(undefined);
    try { await update({ disabledLanguagePacks: next }); setLanguagePacks(await desktop.listLanguagePacks()); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!open) return;
    setPage(initialPage);
    setResourceChanges([]);
    resourceBaselineRef.current.clear();
    editorSettingsBaselineRef.current = {
      disabledEditors: settings.disabledFileEditors,
      disabledSkills: settings.disabledFileEditorSkills,
    };
    setDisabledFileEditors([...settings.disabledFileEditors]);
    setDisabledFileEditorSkills([...settings.disabledFileEditorSkills]);
  }, [initialPage, open]);
  useEffect(() => {
    if (open && page === "appearance") void refreshThemes().catch(() => undefined);
  }, [open, page, refreshThemes]);
  useEffect(() => {
    if (!cwd) setSkillHubScope("user");
  }, [cwd]);
  useEffect(() => {
    if (!open || !["skills", "extensions", "editors", "languagePacks"].includes(page) || !runtimeId || !cwd) return;
    setBusy(true);
    setError(undefined);
    void desktop.piResources(cwd, runtimeId)
      .then((found) => {
        for (const resource of found) {
          const resourceKey = resourceChangeKey(resource, "resource");
          if (!resourceBaselineRef.current.has(resourceKey))
            resourceBaselineRef.current.set(resourceKey, resource.enabled);
          if (resource.fileFormat) {
            const pluginKey = resourceChangeKey(resource, "file-format");
            if (!resourceBaselineRef.current.has(pluginKey))
              resourceBaselineRef.current.set(pluginKey, resource.fileFormat.enabled);
          }
        }
        setResources(withPendingResourceChanges(found, resourceChanges));
      })
      .catch((cause) => setError(String(cause)))
      .finally(() => setBusy(false));
  }, [cwd, open, page, runtimeId]);
  useEffect(() => {
    if (!open || !["editors", "languagePacks"].includes(page)) return;
    let cancelled = false;
    void desktop.firstPartyFileFormatPlugins()
      .then((plugins) => {
        if (!cancelled)
          setFirstPartyEditors(
            [...plugins].sort((left, right) => left.name.localeCompare(right.name)),
          );
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open, page]);
  useEffect(() => {
    if (!open || page !== "editors") return;
    void desktop.listLanguagePacks().then(setLanguagePacks).catch((cause) => setError(String(cause)));
  }, [open, page]);
  useEffect(() => {
    if (!open || !["skills", "extensions", "editors", "languagePacks"].includes(page)) return;
    let cancelled = false;
    setResourcesLocked(true);
    const refreshStatus = () => {
      void desktop.workerPoolStatus()
        .then((status) => {
          if (!cancelled) setResourcesLocked(status.busy > 0);
        })
        .catch(() => {
          if (!cancelled) setResourcesLocked(true);
        });
    };
    refreshStatus();
    const timer = window.setInterval(refreshStatus, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, page]);
  useEffect(() => {
    if (!open || page !== "models") return;
    // Authentication happens in a separate Pi terminal. Always read the real
    // credential-backed catalog when this page opens instead of reusing the
    // pre-login cache.
    let timeout: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      timeout = window.setTimeout(() => void refresh(true), 0);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [open, page]);
  useEffect(() => {
    if (!open || page !== "models" || !pendingProviderLogin) return;
    let cancelled = false;
    const providerId = pendingProviderLogin;
    const poll = async () => {
      if (cancelled || providerLoginPollRef.current) return;
      providerLoginPollRef.current = true;
      try {
        const catalog = await desktop.providerCatalog();
        if (cancelled) return;
        catalogRefreshGenerationRef.current += 1;
        applyProviderCatalog(catalog);
        setBusy(false);
        const provider = catalog.find((item) => item.id === providerId);
        if (!provider?.configured) return;
        setPendingProviderLogin((current) => current === providerId ? undefined : current);
        setNotice(settings.locale === "en-US"
          ? `${providerDisplayName(provider)} is configured.`
          : `${providerDisplayName(provider)} 已配置。`);
        try {
          await desktop.reloadPiRuntimes();
          if (!cancelled) window.dispatchEvent(new Event("agent-k-model-changed"));
        } catch {
          // The credential status is already correct. A busy runtime may defer
          // its reload, but must not make the provider appear unconfigured.
        }
      } catch {
        // The external login terminal may still be starting. Keep polling
        // without surfacing transient RPC errors as settings failures.
      } finally {
        providerLoginPollRef.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 800);
    const timeout = window.setTimeout(() => {
      setPendingProviderLogin((current) => current === providerId ? undefined : current);
    }, 5 * 60_000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
      window.removeEventListener("focus", onFocus);
    };
  }, [open, page, pendingProviderLogin, settings.locale]);
  useEffect(() => {
    if (!open || page !== "about") return;
    void loadAboutData()
      .then(([nextVersion, nextRuntimeInfo]) => {
        setVersion(nextVersion);
        setRuntimeInfo(nextRuntimeInfo);
      })
      .catch(() => undefined);
  }, [open, page]);
  useEffect(() => {
    if (!open || page !== "agentSettings") return;
    void loadBrowserData().then(setBrowsers).catch(() => undefined);
    void desktop.cacheDirectoryInfo().then(setCacheDirectoryInfo).catch(() => undefined);
  }, [open, page]);
  useEffect(() => {
    if (!open) return;
    // Populate the two system-information pages while the user is still on
    // the initial models page. Both calls are cached, so opening either page
    // later only performs the small React state commit.
    const timeout = window.setTimeout(() => {
      void loadAboutData()
        .then(([nextVersion, nextRuntimeInfo]) => {
          setVersion(nextVersion);
          setRuntimeInfo(nextRuntimeInfo);
        })
        .catch(() => undefined);
      void loadBrowserData().then(setBrowsers).catch(() => undefined);
    }, 80);
    return () => window.clearTimeout(timeout);
  }, [open]);
  const closeDialog = async () => {
    const editorSettingsChanged =
      !sameStringSet(
        editorSettingsBaselineRef.current.disabledEditors,
        disabledFileEditors,
      ) ||
      !sameStringSet(
        editorSettingsBaselineRef.current.disabledSkills,
        disabledFileEditorSkills,
      );
    if (resourcesLocked && (resourceChanges.length > 0 || editorSettingsChanged)) {
      setError(t("resourcesLocked"));
      return;
    }
    const changes = resourceChanges;
    if (editorSettingsChanged) {
      setBusy(true);
      setError(undefined);
      try {
        await update({
          disabledFileEditors,
          disabledFileEditorSkills,
        });
      } catch (cause) {
        setError(String(cause));
        setBusy(false);
        return;
      }
    }
    setResourceChanges([]);
    resourceBaselineRef.current.clear();
    setBusy(false);
    onClose(changes, editorSettingsChanged);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void closeDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabledFileEditors, disabledFileEditorSkills, open, resourceChanges, resourcesLocked]);
  const sessionAllowed = Boolean(
    sessionId && sessionStorage.getItem(`agent-k-permission:${sessionId}`) === "allow",
  );
  const setPermissionMode = async (mode: "ask" | "session" | "full") => {
    if (sessionId) {
      const allowed = mode === "session";
      if (allowed) sessionStorage.setItem(`agent-k-permission:${sessionId}`, "allow");
      else sessionStorage.removeItem(`agent-k-permission:${sessionId}`);
      await desktop.setSessionPermission(sessionId, allowed);
    }
    await update({ permissionMode: mode === "full" ? "full" : "ask" });
    window.dispatchEvent(new Event("agent-k-permission"));
  };
  const grouped = useMemo(() => {
    const custom = providers.filter((item) => item.source === "custom" && !(item.id === "agent-k-llama-cpp" && item.agentKManaged));
    const builtIn = providers.filter((item) => item.source !== "custom");
    return { custom, builtIn };
  }, [providers]);
  const enabledModels = useMemo(
    () => models.filter((model) => modelIsEnabled(settings, model.provider, model.id)),
    [models, settings.disabledModelProviders, settings.disabledModels],
  );
  const selectedDefaultModel = enabledModels.find(
    (model) => modelKey(model.provider, model.id) === settings.defaultModel,
  );
  const defaultThinkingLevels = supportedThinkingLevels(selectedDefaultModel);
  useEffect(() => {
    if (
      selectedDefaultModel &&
      !defaultThinkingLevels.includes(settings.defaultThinkingLevel)
    ) void update({ defaultThinkingLevel: "off" });
  }, [selectedDefaultModel, settings.defaultThinkingLevel]);
  const selectDefaultModel = (key: string) => {
    const selected = enabledModels.find(
      (model) => modelKey(model.provider, model.id) === key,
    );
    const supported = supportedThinkingLevels(selected);
    void update({
      defaultModel: key,
      defaultThinkingLevel: supported.includes(settings.defaultThinkingLevel)
        ? settings.defaultThinkingLevel
        : "off",
    });
  };
  if (!open) return null;

  const authenticate = async (provider: ProviderCatalogItem, authType: "api_key" | "oauth") => {
    setError(undefined);
    setNotice(undefined);
    // These providers collect additional account/project fields. Let Pi own
    // that version-specific flow instead of duplicating private provider logic.
    const structuredAuth = new Set([
      "amazon-bedrock",
      "cloudflare-ai-gateway",
      "cloudflare-workers-ai",
      "google-vertex",
    ]);
    if (authType === "api_key" && !structuredAuth.has(provider.id)) {
      setAuthTarget(provider);
      setAuthKey("");
      return;
    }
    setBusy(true);
    try {
      await desktop.openProviderLogin(provider.id);
      if (provider.id === "openai-codex") {
        await reloadModelConfiguration();
        setPendingProviderLogin(undefined);
        setNotice(settings.locale === "en-US" ? "OpenAI OAuth login completed." : "OpenAI OAuth 登录完成。");
        return;
      }
      lastCatalogRefreshRef.current = 0;
      setPendingProviderLogin(provider.id);
      setNotice(`${t("loginTerminalOpened")} /login ${provider.id}`);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const saveAuthKey = async () => {
    if (!authTarget || !authKey.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await desktop.saveProviderApiKey(authTarget.id, authKey);
      await reloadModelConfiguration();
      setAuthTarget(undefined);
      setAuthKey("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const reloadProviders = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await reloadModelConfiguration();
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  };
  const logout = async (provider: ProviderCatalogItem) => {
    setBusy(true);
    setError(undefined);
    try {
      await desktop.logoutProvider(provider.id);
      await reloadModelConfiguration();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const saveDraft = async () => {
    const models = new Map(draft.models.map((model) => [model.id, model]));
    const contextWindow = manualContextWindow.trim() ? Number(manualContextWindow) : undefined;
    if (manualModel.trim()) models.set(manualModel.trim(), {
      ...models.get(manualModel.trim()),
      id: manualModel.trim(),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      reasoning: manualReasoning,
      input: manualVision ? ["text", "image"] : ["text"],
      ...(manualReasoning ? { thinkingLevelMap: configuredThinkingLevelMap(manualThinkingLevels) } : {}),
    });
    if (!draft.id.trim() || !draft.baseUrl.trim() || models.size === 0) {
      setError("Provider ID、Base URL 和至少一个模型 ID 为必填项");
      return;
    }
    setBusy(true);
    try {
      const unchecked = [...models.values()].filter((model) =>
        !model.thinkingLevelMap && model.assessment?.source !== "unverified");
      if (unchecked.length) {
        const assessed = await desktop.inferModelReasoning(unchecked.map((model) => model.id));
        const assessmentByModel = new Map(assessed.map((model) => [model.id, model]));
        for (const model of unchecked) {
          const assessment = assessmentByModel.get(model.id);
          models.set(model.id, {
            ...model,
            ...assessment,
            input: model.input?.includes("image") || assessment?.input?.includes("image")
              ? ["text", "image"]
              : ["text"],
          });
        }
      }
      await desktop.saveProvider({ ...draft, previousId: editedProviderIdRef.current, models: [...models.values()] });
      if (draft.apiKey) {
        await desktop.saveProviderApiKey(draft.id, draft.apiKey);
      }
      await reloadModelConfiguration();
      setEditor(undefined);
      setManualModel("");
      setManualContextWindow("");
      setManualReasoning(false);
      setManualVision(false);
      setManualThinkingLevels([]);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const deleteProvider = async (provider: ProviderCatalogItem) => {
    setBusy(true);
    setError(undefined);
    try {
      await desktop.deleteProvider(provider.id);
      await update({
        disabledModelProviders: settings.disabledModelProviders.filter(
          (id) => id !== provider.id,
        ),
        disabledModels: settings.disabledModels.filter(
          (key) => !key.startsWith(`${provider.id}/`),
        ),
        defaultModel: settings.defaultModel.startsWith(`${provider.id}/`) ? "" : settings.defaultModel,
        ...(settings.defaultModel.startsWith(`${provider.id}/`)
          ? { defaultThinkingLevel: "off" as const }
          : {}),
        sessionModels: Object.fromEntries(
          Object.entries(settings.sessionModels).filter(([, model]) =>
            !model.startsWith(`${provider.id}/`),
          ),
        ),
      });
      await reloadModelConfiguration();
      setPendingDelete(undefined);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const toggleProviderAvailability = async (providerId: string) => {
    const disabling = !settings.disabledModelProviders.includes(providerId);
    setBusy(true);
    setError(undefined);
    try {
      await update({
        disabledModelProviders: disabling
          ? [...settings.disabledModelProviders, providerId]
          : settings.disabledModelProviders.filter((id) => id !== providerId),
        ...(disabling && settings.defaultModel.startsWith(`${providerId}/`)
          ? { defaultModel: "", defaultThinkingLevel: "off" as const }
          : {}),
        ...(disabling
          ? {
              sessionModels: Object.fromEntries(
                Object.entries(settings.sessionModels).filter(([, model]) =>
                  !model.startsWith(`${providerId}/`),
                ),
              ),
            }
          : {}),
      });
      window.dispatchEvent(new Event("agent-k-model-changed"));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const toggleModelAvailability = async (key: string) => {
    const disabling = !settings.disabledModels.includes(key);
    setBusy(true);
    setError(undefined);
    try {
      await update({
        disabledModels: disabling
          ? [...settings.disabledModels, key]
          : settings.disabledModels.filter((entry) => entry !== key),
        ...(disabling && settings.defaultModel === key
          ? { defaultModel: "", defaultThinkingLevel: "off" as const }
          : {}),
        ...(disabling
          ? {
              sessionModels: Object.fromEntries(
                Object.entries(settings.sessionModels).filter(([, model]) => model !== key),
              ),
            }
          : {}),
      });
      window.dispatchEvent(new Event("agent-k-model-changed"));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const toggleProviderModels = (providerId: string) => {
    setExpandedProviders((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };
  const setResourceState = (
    resource: PiResource,
    enabled: boolean,
    fileFormatEnabled = resource.fileFormat?.enabled,
  ) => {
    const nextResource: PiResource = {
      ...resource,
      enabled,
      ...(resource.fileFormat && fileFormatEnabled !== undefined
        ? { fileFormat: { ...resource.fileFormat, enabled: fileFormatEnabled } }
        : {}),
    };
    setResources((current) => current.map((item) =>
      item.kind === resource.kind && item.path === resource.path
        ? nextResource
        : item,
    ));
    setResourceChanges((current) => {
      const resourceKey = resourceChangeKey(resource, "resource");
      const pluginKey = resourceChangeKey(resource, "file-format");
      const next = current.filter((change) => {
        const key = resourceChangeKey(change.resource, change.target);
        return key !== resourceKey && key !== pluginKey;
      });
      if (resourceBaselineRef.current.get(resourceKey) !== enabled)
        next.push({ resource: nextResource, enabled, target: "resource" });
      if (
        nextResource.fileFormat &&
        fileFormatEnabled !== undefined &&
        resourceBaselineRef.current.get(pluginKey) !== fileFormatEnabled
      ) next.push({
        resource: nextResource,
        enabled: fileFormatEnabled,
        target: "file-format",
      });
      return next;
    });
  };
  const toggleResource = (resource: PiResource) => {
    const enabled = !resource.enabled;
    setResourceState(
      resource,
      enabled,
      enabled && resource.fileFormat ? true : resource.fileFormat?.enabled,
    );
  };
  const toggleFileFormat = (resource: PiResource) => {
    if (!resource.fileFormat) return;
    const enabled = !resource.fileFormat.enabled;
    setResourceState(resource, enabled ? resource.enabled : false, enabled);
  };
  const toggleBuiltinEditor = (id: string) => {
    const enabled = !disabledFileEditors.includes(id);
    if (enabled) {
      setDisabledFileEditors((current) => [...new Set([...current, id])]);
      setDisabledFileEditorSkills((current) => [...new Set([...current, id])]);
      return;
    }
    setDisabledFileEditors((current) => current.filter((value) => value !== id));
  };
  const toggleBuiltinEditorSkill = (id: string) => {
    const enabled = !disabledFileEditorSkills.includes(id);
    if (enabled) {
      setDisabledFileEditorSkills((current) => [...new Set([...current, id])]);
      return;
    }
    setDisabledFileEditorSkills((current) => current.filter((value) => value !== id));
    setDisabledFileEditors((current) => current.filter((value) => value !== id));
  };
  const previewSkill = async () => {
    if (!skillHubUrl.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      setSkillHubPreview(await desktop.previewSkillHub(skillHubUrl.trim()));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const installSkill = async () => {
    if (!skillHubPreview || !cwd) return;
    setBusy(true);
    setError(undefined);
    try {
      await desktop.installSkillHub(
        skillHubPreview.sourceUrl,
        skillHubPreview.hash,
        skillHubScope,
        cwd,
      );
      await desktop.reloadPiRuntimes();
      window.dispatchEvent(new Event("agent-k-resources-changed"));
      setSkillHubPreview(undefined);
      setSkillHubUrl("");
      setResources(await desktop.piResources(cwd, runtimeId));
      setNotice(t("skillHubInstalled"));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) void closeDialog();
    }}>
      <section aria-label={t("settings")} aria-modal="true" className="settings-dialog" role="dialog">
        <header className="settings-header">
          <strong>{t("settings")}</strong>
          <button aria-label={t("close")} className="settings-close" onClick={() => void closeDialog()} type="button">×</button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav">
            {(["models", "appearance", "agentSettings", "skills", "extensions", "editors", "languagePacks", "permissions", "about"] as SettingsPage[]).map((item) => (
              <button className={page === item ? "is-active" : ""} key={item} onClick={() => { setPage(item); onPageChange?.(item); }} type="button">
                <i className={`fa-solid ${item === "models" ? "fa-microchip" : item === "appearance" ? "fa-circle-half-stroke" : item === "agentSettings" ? "fa-sliders" : item === "skills" ? "fa-wand-magic-sparkles" : item === "extensions" ? "fa-puzzle-piece" : item === "editors" ? "fa-pen-ruler" : item === "languagePacks" ? "fa-code" : item === "permissions" ? "fa-shield-halved" : "fa-circle-info"}`} />
                {t(item)}
              </button>
            ))}
          </nav>
          <main className="settings-content">
            {error && <p className={editor ? "settings-error settings-error-in-subdialog" : "settings-error"} role="alert">{error}</p>}
            {notice && <p className="settings-description">{notice}</p>}
            {page === "appearance" && (
              <>
                <h2>{t("appearance")}</h2>
                <div className="settings-section">
                  <div className="theme-carousel-actions">
                    <span className="settings-description">选择预览卡立即应用主题</span>
                    <div className="theme-carousel-tools"><button className={settings.theme === "system" ? "is-active" : ""} onClick={() => void update({ theme: "system" })} type="button"><i className="fa-solid fa-desktop" /> {t("systemTheme")}</button><button onClick={() => setExtensionPicker("theme")} type="button">{t("importTheme")}</button></div>
                  </div>
                  <div aria-label="主题轮播" className="theme-carousel">
                    {themes.map((theme, index) => {
                      const offset = (index - themeSlideIndex + themes.length) % themes.length;
                      const position = offset === 0 ? "current" : offset === 1 ? "next" : offset === themes.length - 1 ? "previous" : "hidden";
                      return <article className={`theme-preview-card ${position} ${settings.theme === theme.id ? "is-active" : ""}`} key={theme.id} style={previewStyle(theme)}>
                      <button aria-pressed={settings.theme === theme.id} className="theme-preview-select" onClick={() => selectThemeSlide(index)} type="button">
                        <div className="theme-preview-window"><div className="theme-preview-titlebar"><i /><i /><i /></div><div className="theme-preview-sidebar"><span /><span /><span /></div><div className="theme-preview-content"><strong>Agent K</strong><small>Theme preview</small><b>const theme =</b><em> {theme.name}</em><div /></div></div>
                        <span className="theme-preview-name">{theme.name}</span><small>{theme.base}</small>
                      </button>
                      {!theme.builtin && <button aria-label={`${t("removeTheme")}: ${theme.name}`} className="theme-preview-remove" onClick={() => void removeTheme(theme.id)} type="button"><i className="fa-solid fa-trash" /></button>}
                      {position === "current" && <div className="theme-preview-nav"><button aria-label="上一个主题" onClick={() => changeThemeSlide(-1)} type="button"><i className="fa-solid fa-chevron-left" /></button><button aria-label="下一个主题" onClick={() => changeThemeSlide(1)} type="button"><i className="fa-solid fa-chevron-right" /></button></div>}
                    </article>;
                    })}
                  </div>
                </div>
                <div className="settings-section">
                  <label htmlFor="settings-language">{t("language")}</label>
                  <select id="settings-language" onChange={(event) => void update({ locale: event.target.value as "zh-CN" | "en-US" })} value={settings.locale}>
                    <option value="zh-CN">{t("chinese")}</option>
                    <option value="en-US">{t("english")}</option>
                  </select>
                </div>
              </>
            )}
            {page === "agentSettings" && (
              <>
                <h2>{t("agentSettings")}</h2>
                <div className="settings-section">
                  <label htmlFor="settings-browser">{t("browser")}</label>
                  <select
                    id="settings-browser"
                    onChange={(event) => void update({ browserId: event.target.value })}
                    value={settings.browserId}
                  >
                    {browsers.map((browser) => (
                      <option key={browser.id} value={browser.id}>
                        {browser.id === "default" ? t("defaultBrowser") : browser.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-section">
                  <label htmlFor="settings-pi-executable">{t("piExecutable")}</label>
                  <p className="settings-inline-description">{t("piExecutableDescription")}</p>
                  <input
                    id="settings-pi-executable"
                    onChange={(event) => void update({ piExecutable: event.target.value })}
                    placeholder={t("piExecutablePlaceholder")}
                    value={settings.piExecutable}
                  />
                </div>
                <div className="settings-section">
                  <label htmlFor="settings-terminal-charset">{t("terminalCharset")}</label>
                  <p className="settings-inline-description">{t("terminalCharsetDescription")}</p>
                  <select
                    id="settings-terminal-charset"
                    onChange={(event) => void update({ terminalCharset: event.target.value as "utf-8" | "gbk" })}
                    value={settings.terminalCharset}
                  >
                    <option value="utf-8">{t("terminalCharsetUtf8")}</option>
                    <option value="gbk">{t("terminalCharsetGbk")}</option>
                  </select>
                </div>
                <div className="settings-section">
                  <label htmlFor="settings-cache-directory">{t("cacheDirectory")}</label>
                  <p className="settings-inline-description">{t("cacheDirectoryDescription")}</p>
                  <div className="inline-field settings-path-field">
                    <input
                      id="settings-cache-directory"
                      readOnly
                      value={settings.cacheDirectory || cacheDirectoryInfo?.defaultPath || ""}
                    />
                    <button onClick={() => void chooseCacheDirectory()} type="button">{t("cacheDirectoryBrowse")}</button>
                    {settings.cacheDirectory ? <button onClick={() => void resetCacheDirectory()} type="button">{t("cacheDirectoryDefault")}</button> : null}
                  </div>
                  {cacheDirectoryInfo ? <small className="settings-active-path">{t("cacheDirectoryActive")}：{cacheDirectoryInfo.activePath}</small> : null}
                </div>
                <div className="settings-section">
                  <label>{t("workerPoolSize")}</label>
                  <p className="settings-inline-description">{t("workerPoolDescription")}</p>
                  <div className="segmented-control">
                    {([2, 3, 4] as const).map((size) => (
                      <button
                        className={settings.workerPoolSize === size ? "is-active" : ""}
                        disabled={poolBusy}
                        key={size}
                        onClick={() => {
                          setPoolBusy(true);
                          setError(undefined);
                          void update({ workerPoolSize: size })
                            .catch((cause) => setError(String(cause)))
                            .finally(() => setPoolBusy(false));
                        }}
                        type="button"
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-toggle-label">
                    <span id="settings-agent-loop-detection-label">{t("agentLoopDetection")}</span>
                    <button
                      aria-checked={settings.agentLoopDetectionEnabled}
                      aria-labelledby="settings-agent-loop-detection-label"
                      className={settings.agentLoopDetectionEnabled ? "resource-toggle is-active" : "resource-toggle"}
                      id="settings-agent-loop-detection"
                      onClick={() => {
                        setError(undefined);
                        void update({ agentLoopDetectionEnabled: !settings.agentLoopDetectionEnabled })
                          .catch((cause) => setError(String(cause)));
                      }}
                      role="switch"
                      type="button"
                    ><span /></button>
                  </div>
                  <p className="settings-inline-description">{t("agentLoopDetectionDescription")}</p>
                </div>
                <div className="settings-section">
                  <div className="settings-toggle-label">
                    <span id="settings-environment-prompt-label">{t("environmentPrompt")}</span>
                    <button
                      aria-checked={settings.environmentPromptEnabled}
                      aria-labelledby="settings-environment-prompt-label"
                      className={settings.environmentPromptEnabled ? "resource-toggle is-active" : "resource-toggle"}
                      id="settings-environment-prompt"
                      onClick={() => {
                        setError(undefined);
                        void update({ environmentPromptEnabled: !settings.environmentPromptEnabled })
                          .catch((cause) => setError(String(cause)));
                      }}
                      role="switch"
                      type="button"
                    ><span /></button>
                  </div>
                  <p className="settings-inline-description">{t("environmentPromptDescription")}</p>
                </div>
                <div className="settings-section">
                  <div className="settings-toggle-label">
                    <span id="settings-auto-compact-label">{t("autoCompact")}</span>
                    <button
                      aria-checked={settings.autoCompactEnabled}
                      aria-labelledby="settings-auto-compact-label"
                      className={settings.autoCompactEnabled ? "resource-toggle is-active" : "resource-toggle"}
                      id="settings-auto-compact"
                      onClick={() => void update({ autoCompactEnabled: !settings.autoCompactEnabled })}
                      role="switch"
                      type="button"
                    ><span /></button>
                  </div>
                  <p className="settings-inline-description">{t("autoCompactDescription")}</p>
                  <label htmlFor="settings-auto-compact-prompt">{t("autoCompactPrompt")}</label>
                  <textarea
                    id="settings-auto-compact-prompt"
                    onBlur={(event) => void update({ autoCompactPrompt: event.target.value })}
                    placeholder={t("autoCompactPromptPlaceholder")}
                    defaultValue={settings.autoCompactPrompt}
                    rows={4}
                  />
                </div>
              </>
            )}
            {page === "permissions" && (
              <>
                <h2>{t("permissions")}</h2>
                <p className="settings-description">{t("permissionDescription")}</p>
                <div className="permission-options">
                  <button className={settings.permissionMode === "ask" && !sessionAllowed ? "is-active" : ""} onClick={() => void setPermissionMode("ask")} type="button"><i className="fa-regular fa-circle-question" /><span><strong>{t("permissionAsk")}</strong><small>bash · write · edit</small></span></button>
                  <button className={sessionAllowed ? "is-active" : ""} disabled={!sessionId} onClick={() => void setPermissionMode("session")} type="button"><i className="fa-regular fa-clock" /><span><strong>{t("permissionSession")}</strong><small>{sessionId ?? "No active session"}</small></span></button>
                  <button className={settings.permissionMode === "full" ? "is-active" : ""} onClick={() => void setPermissionMode("full")} type="button"><i className="fa-solid fa-unlock" /><span><strong>{t("permissionFull")}</strong><small>bash · write · edit</small></span></button>
                </div>
              </>
            )}
            {(page === "skills" || page === "extensions") && (
              <>
                <div className="settings-title-row">
                  <h2>{t(page)}</h2>
                  <button
                    disabled={busy || !runtimeId || resourcesLocked}
                    onClick={() => {
                      if (!runtimeId || !cwd) return;
                      setBusy(true);
                      void desktop.piResources(cwd, runtimeId)
                        .then((found) => {
                          for (const resource of found) {
                            const resourceKey = resourceChangeKey(resource, "resource");
                            if (!resourceBaselineRef.current.has(resourceKey))
                              resourceBaselineRef.current.set(resourceKey, resource.enabled);
                            if (resource.fileFormat) {
                              const pluginKey = resourceChangeKey(resource, "file-format");
                              if (!resourceBaselineRef.current.has(pluginKey))
                                resourceBaselineRef.current.set(pluginKey, resource.fileFormat.enabled);
                            }
                          }
                          setResources(withPendingResourceChanges(found, resourceChanges));
                        })
                        .catch((cause) => setError(String(cause)))
                        .finally(() => setBusy(false));
                    }}
                    type="button"
                  >
                    <i className="fa-solid fa-rotate" /> {t("refresh")}
                  </button>
                </div>
                <p className="settings-description">{t("resourceDescription")}</p>
                {resourcesLocked && (
                  <p className="resource-lock-notice" role="status">
                    <i className="fa-solid fa-spinner fa-spin" /> {t("resourcesLocked")}
                  </p>
                )}
                {page === "skills" && (
                  <section className="skill-hub">
                    <div className="skill-hub-heading">
                      <div>
                        <h3><i className="fa-solid fa-store" /> {t("skillHub")}</h3>
                        <p>{t("skillHubDescription")}</p>
                      </div>
                      <button
                        onClick={() => void desktop.openExternalUrl("https://skills.sh/", settings.browserId)}
                        type="button"
                      >
                        <i className="fa-solid fa-arrow-up-right-from-square" /> skills.sh
                      </button>
                    </div>
                    <div className="skill-hub-import">
                      <input
                        aria-label={t("skillHubUrl")}
                        onChange={(event) => setSkillHubUrl(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void previewSkill();
                        }}
                        placeholder={t("skillHubUrlPlaceholder")}
                        value={skillHubUrl}
                      />
                      <button disabled={busy || !skillHubUrl.trim()} onClick={() => void previewSkill()} type="button">
                        <i className="fa-regular fa-eye" /> {t("skillHubPreview")}
                      </button>
                    </div>
                    <div className="skill-hub-featured">
                      <span>{t("skillHubFeatured")}</span>
                      {featuredSkills.map((skill) => (
                        <button key={skill.sourceUrl} onClick={() => setSkillHubUrl(skill.sourceUrl)} type="button">
                          <strong>{skill.name}</strong><small>{skill.description}</small>
                        </button>
                      ))}
                    </div>
                    <small>{t("skillHubSafety")}</small>
                  </section>
                )}
                <div className="resource-list">
                  {resources
                    .filter((resource) => resource.kind === (page === "skills" ? "skill" : "extension"))
                    .map((resource) => (
                      <article className="resource-card" key={`${resource.kind}:${resource.path}`}>
                        <div>
                          <strong>{resource.name}</strong>
                          <small>{resource.description || resource.path}</small>
                          <span>{resource.scope === "project" ? t("projectScope") : t("userScope")} · {resource.origin === "package" ? resource.source : resource.path}</span>
                        </div>
                        <div className="resource-card-actions">
                          {resource.kind === "skill" && <button onClick={() => setSelectedSkill(resource)} type="button">{t("skillDetails")}</button>}
                          <div className="resource-switch">
                            <span>{resource.kind === "skill" ? t("piSkill") : t("extensions")}</span>
                            <button
                              aria-checked={resource.enabled}
                              aria-label={`${resource.kind === "skill" ? t("piSkill") : t("extensions")}: ${resource.name}`}
                              className={resource.enabled ? "resource-toggle is-active" : "resource-toggle"}
                              disabled={!cwd || resourcesLocked}
                              onClick={() => toggleResource(resource)}
                              role="switch"
                              type="button"
                            >
                              <span />
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  {!busy && resources.every((resource) => resource.kind !== (page === "skills" ? "skill" : "extension")) && (
                    <p className="empty-settings">{t("noResources")}</p>
                  )}
                </div>
              </>
            )}
            {page === "editors" && (
              <>
                <div className="settings-title-row">
                  <h2>{t("editors")}</h2>
                  <div className="settings-title-actions"><button disabled={busy || resourcesLocked} onClick={() => setExtensionPicker("editor")} type="button">
                    <i className="fa-solid fa-box-open" /> 安装扩展
                  </button><button
                    disabled={busy || !runtimeId || resourcesLocked}
                    onClick={() => {
                      if (!runtimeId || !cwd) return;
                      setBusy(true);
                      void desktop.piResources(cwd, runtimeId)
                        .then((found) => {
                          for (const resource of found) {
                            const resourceKey = resourceChangeKey(resource, "resource");
                            if (!resourceBaselineRef.current.has(resourceKey))
                              resourceBaselineRef.current.set(resourceKey, resource.enabled);
                            if (resource.fileFormat) {
                              const pluginKey = resourceChangeKey(resource, "file-format");
                              if (!resourceBaselineRef.current.has(pluginKey))
                                resourceBaselineRef.current.set(pluginKey, resource.fileFormat.enabled);
                            }
                          }
                          setResources(withPendingResourceChanges(found, resourceChanges));
                        })
                        .catch((cause) => setError(String(cause)))
                        .finally(() => setBusy(false));
                    }}
                    type="button"
                  >
                    <i className="fa-solid fa-rotate" /> {t("refresh")}
                  </button></div>
                </div>
                <p className="settings-description">{t("editorManagerDescription")}</p>
                {resourcesLocked && (
                  <p className="resource-lock-notice" role="status">
                    <i className="fa-solid fa-spinner fa-spin" /> {t("resourcesLocked")}
                  </p>
                )}
                <div className="editor-manager-heading">
                  <h3>{t("builtinEditors")}</h3>
                  <p>{t("builtinEditorsDescription")}</p>
                </div>
                <div className="resource-list editor-builtin-list">
                  {firstPartyEditors.map((plugin) => {
                    const editorEnabled = !disabledFileEditors.includes(plugin.id);
                    const skillEnabled = !disabledFileEditorSkills.includes(plugin.id);
                    return (
                      <article className="resource-card" key={plugin.id}>
                        <div>
                          <strong>{plugin.name}</strong>
                          <small title={plugin.path}>{plugin.id} · v{plugin.version ?? "0.0.0"}</small>
                          <span>{plugin.description || `${t("builtIn")} · ${plugin.editor}`}</span>
                        </div>
                        <div className="resource-card-actions">
                          <button aria-label={`${plugin.name} Skill`} className="editor-skill-button" disabled={busy || !cwd} onClick={() => void viewEditorSkill(plugin)} title="查看 Editor Skill" type="button"><i aria-hidden="true" className="fa-regular fa-file-lines" /></button>
                          <div className="resource-switch">
                            <span>{t("editorHost")}</span>
                            <button
                              aria-checked={editorEnabled}
                              aria-label={`${t("editorHost")}: ${plugin.name}`}
                              className={editorEnabled ? "resource-toggle is-active" : "resource-toggle"}
                              disabled={busy || resourcesLocked}
                              onClick={() => toggleBuiltinEditor(plugin.id)}
                              role="switch"
                              type="button"
                            >
                              <span />
                            </button>
                          </div>
                          <div className="resource-switch">
                            <span>{t("editorSkill")}</span>
                            <button
                              aria-checked={skillEnabled}
                              aria-label={`${t("editorSkill")}: ${plugin.name}`}
                              className={skillEnabled ? "resource-toggle is-active" : "resource-toggle"}
                              disabled={busy || resourcesLocked}
                              onClick={() => toggleBuiltinEditorSkill(plugin.id)}
                              role="switch"
                              type="button"
                            >
                              <span />
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
                <div className="editor-manager-heading">
                  <h3>{t("installedEditors")}</h3>
                  <p>{t("filePluginDependency")}</p>
                </div>
                <div className="resource-list editor-extension-list">
                  {resources
                    .filter((resource) => resource.kind === "skill" && resource.fileFormat)
                    .map((resource) => (
                      <article className="resource-card" key={`editor:${resource.path}`}>
                        <div>
                          <strong>{resource.fileFormat?.name ?? resource.name}</strong>
                          <small title={resource.path}>{resource.fileFormat?.id}{resource.fileFormat?.version ? ` · v${resource.fileFormat.version}` : ""}</small>
                          <span>{resource.description || (resource.scope === "project" ? t("projectScope") : t("userScope"))}</span>
                        </div>
                        <div className="resource-card-actions">
                          <button aria-label={`${resource.fileFormat?.name ?? resource.name} Skill`} className="editor-skill-button" disabled={busy || !cwd || !resource.fileFormat} onClick={() => resource.fileFormat && void viewEditorSkill({ id: resource.fileFormat.id, name: resource.fileFormat.name })} title="查看 Editor Skill" type="button"><i aria-hidden="true" className="fa-regular fa-file-lines" /></button>
                          <div className="resource-switch">
                            <span>{t("editorHost")}</span>
                            <button
                              aria-checked={resource.fileFormat?.enabled ?? false}
                              aria-label={`${t("editorHost")}: ${resource.name}`}
                              className={resource.fileFormat?.enabled ? "resource-toggle is-active" : "resource-toggle"}
                              disabled={!cwd || resourcesLocked}
                              onClick={() => toggleFileFormat(resource)}
                              role="switch"
                              type="button"
                            >
                              <span />
                            </button>
                          </div>
                          <div className="resource-switch">
                            <span>{t("editorSkill")}</span>
                            <button
                              aria-checked={resource.enabled}
                              aria-label={`${t("editorSkill")}: ${resource.name}`}
                              className={resource.enabled ? "resource-toggle is-active" : "resource-toggle"}
                              disabled={!cwd || resourcesLocked}
                              onClick={() => toggleResource(resource)}
                              role="switch"
                              type="button"
                            >
                              <span />
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  {!busy && resources.every((resource) => !resource.fileFormat) && (
                    <p className="empty-settings">{t("noEditorExtensions")}</p>
                  )}
                </div>
              </>
            )}
            {page === "languagePacks" && (
              <>
                <div className="settings-title-row"><h2>{t("languagePacks")}</h2><div className="settings-title-actions language-pack-install-action"><button disabled={busy || resourcesLocked} onClick={() => setExtensionPicker("language")} type="button"><i className="fa-solid fa-box-open" /> 安装 Language Pack</button></div></div>
                <p className="settings-description">每个包原子提供 Editor、Skill、语义、工具链、编译、运行、测试和调试能力；启停无需重启 Agent K。</p>
                <div className="resource-list editor-language-list">
                  {languagePacks.map((plugin) => <article className="resource-card" key={plugin.id}>
                    <div><strong>{plugin.displayName}</strong><small>{plugin.id} · v{plugin.version} · {plugin.platforms.join(" / ")}</small><span>{plugin.languages.join(", ")} · {plugin.actions.length} actions</span><small>工具：{plugin.toolchainSources.map((tool) => `${tool.id} ${tool.version} (${tool.source})`).join(" · ")}</small><small>权限：{plugin.permissions.externalTools.join(", ")}{plugin.permissions.network ? " · network" : ""}{plugin.permissions.workspaceWrite ? " · workspace write" : ""}</small></div>
                    <div className="resource-card-actions">{plugin.skills.map((skill) => <button aria-label={`${skill.name} Skill`} className="editor-skill-button" disabled={busy} key={skill.name} onClick={() => setEditorSkillViewer({ name: skill.name, source: skill.markdown })} title="查看包内 Skill" type="button"><i aria-hidden="true" className="fa-regular fa-file-lines" /></button>)}<div className="resource-switch"><span>整包启用</span><button aria-checked={plugin.enabled !== false} className={plugin.enabled !== false ? "resource-toggle is-active" : "resource-toggle"} disabled={busy} onClick={() => void toggleLanguagePlugin(plugin.id)} role="switch" type="button"><span /></button></div></div>
                  </article>)}
                  {!busy && !languagePacks.length && <p className="empty-settings">没有可用的 Language Pack</p>}
                </div>
              </>
            )}
            {page === "models" && (
              <>
                <div className="settings-title-row"><h2>{t("models")}</h2><button disabled={busy} onClick={() => void reloadProviders()} type="button"><i className="fa-solid fa-rotate" /> {t("refresh")}</button></div>
                <div className="model-current-row">
                  <label>{t("defaultModel")}<select value={settings.defaultModel} onChange={(event) => selectDefaultModel(event.target.value)}><option value="">—</option>{enabledModels.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name ?? model.id} · {model.provider === "ollama" ? "Ollama" : model.provider === "vllm" ? "vLLM" : model.provider}</option>)}</select></label>
                  <label>{settings.locale === "en-US" ? "Default reasoning level" : "默认推理等级"}<select disabled={!selectedDefaultModel} value={defaultThinkingLevels.includes(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel : "off"} onChange={(event) => void update({ defaultThinkingLevel: event.target.value as ThinkingLevel })}>{defaultThinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
                </div>
                <LocalModelsSettings />
                {providers.length > 0 && <div className="provider-actions"><button onClick={() => { setDraft({ id: "", name: "", baseUrl: "https://", api: "openai-completions", apiKey: "", models: [], local: false }); setManualModel(""); setManualContextWindow(""); setManualReasoning(false); setManualVision(false); setManualThinkingLevels([]); setEditor("provider"); }} type="button"><i className="fa-solid fa-plus" /> {t("providerAdd")}</button><button onClick={() => { setDraft({ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [], local: true }); setManualModel(""); setManualContextWindow(""); setManualReasoning(false); setManualVision(false); setManualThinkingLevels([]); setEditor("local"); }} type="button"><i className="fa-solid fa-desktop" /> {t("localAdd")}</button></div>}
                {[...grouped.custom, ...grouped.builtIn].map((provider) => {
                  const providerEnabled = !settings.disabledModelProviders.includes(provider.id);
                  const expanded = expandedProviders.has(provider.id);
                  return (
                    <article className={providerEnabled ? "provider-card" : "provider-card is-disabled"} key={provider.id}>
                      <div>
                        <strong>{providerDisplayName(provider)}</strong>
                        <small>{provider.id} · {provider.models.length} models</small>
                      </div>
                      <span className={providerEnabled && provider.configured ? "provider-status is-ready" : "provider-status"}>
                        {providerEnabled ? (provider.configured ? t("configured") : t("notConfigured")) : t("disabled")}
                      </span>
                      <div className="provider-card-actions">
                        {provider.models.length > 0 && (
                          <button
                            aria-expanded={expanded}
                            aria-label={`${t("manageModels")} · ${providerDisplayName(provider)}`}
                            onClick={() => toggleProviderModels(provider.id)}
                            title={t("manageModels")}
                            type="button"
                          >
                            <i className={`fa-solid fa-chevron-${expanded ? "up" : "down"}`} />
                          </button>
                        )}
                        {provider.source === "custom" && <button aria-label="Edit" onClick={() => { setDraft({ id: provider.id, name: providerDisplayName(provider), baseUrl: provider.baseUrl ?? "", api: provider.api ?? "openai-completions", apiKey: "", models: provider.models, local: provider.baseUrl?.includes("localhost") ?? false }); const first = provider.models[0]; if (first) selectManualModel(first); else { setManualModel(""); setManualContextWindow(""); setManualReasoning(false); setManualVision(false); setManualThinkingLevels([]); } setEditor("provider"); }} type="button"><i className="fa-regular fa-pen-to-square" /></button>}
                        {provider.authMethods.includes("api_key") && <button disabled={busy} onClick={() => void authenticate(provider, "api_key")} type="button">{t("apiKey")}</button>}
                        {provider.authMethods.includes("oauth") && <button disabled={busy} onClick={() => void authenticate(provider, "oauth")} type="button">{t("oauth")}</button>}
                        {provider.configured && <button disabled={busy} onClick={() => void logout(provider)} type="button">{t("logout")}</button>}
                        {provider.source === "custom" && <button aria-label={t("delete")} onClick={() => setPendingDelete(provider)} type="button"><i className="fa-regular fa-trash-can" /></button>}
                        <button
                          aria-checked={providerEnabled}
                          aria-label={`${providerDisplayName(provider)} · ${providerEnabled ? t("enabled") : t("disabled")}`}
                          className={providerEnabled ? "resource-toggle is-active" : "resource-toggle"}
                          disabled={busy}
                          onClick={() => void toggleProviderAvailability(provider.id)}
                          role="switch"
                          type="button"
                        ><span /></button>
                      </div>
                      {expanded && provider.models.length > 0 && (
                        <div className="provider-model-list">
                          {provider.models.map((model) => {
                            const scopedModelKey = modelKey(provider.id, model.id);
                            const individuallyEnabled = !settings.disabledModels.includes(scopedModelKey);
                            const enabled = providerEnabled && individuallyEnabled;
                            return (
                              <div className={enabled ? "provider-model-row" : "provider-model-row is-disabled"} key={scopedModelKey}>
                                <span><strong>{model.name ?? model.id}</strong>{model.name && model.name !== model.id ? <small>{model.id}</small> : null}</span>
                                <div className="resource-switch">
                                  <span>{t("modelAvailability")}</span>
                                  <button
                                    aria-checked={enabled}
                                    aria-label={`${model.name ?? model.id} · ${enabled ? t("enabled") : t("disabled")}`}
                                    className={enabled ? "resource-toggle is-active" : "resource-toggle"}
                                    disabled={busy || !providerEnabled}
                                    onClick={() => void toggleModelAvailability(scopedModelKey)}
                                    role="switch"
                                    title={!providerEnabled ? `${providerDisplayName(provider)} · ${t("disabled")}` : undefined}
                                    type="button"
                                  ><span /></button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  );
                })}
                {!busy && providers.length === 0 && <p className="empty-settings">{t("noProviders")}</p>}
              </>
            )}
            {page === "about" && (
              <><div className="about-brand"><AgentKLogo className="brand-mark" /><div><h2>Agent K</h2><p>Visual desktop client for Pi</p></div></div><dl className="about-list"><div><dt>{t("appVersion")}</dt><dd>{version}</dd></div><div><dt>{t("piVersion")}</dt><dd>{runtimeInfo.piVersion}</dd></div><div><dt>{t("systemInfo")}</dt><dd>{runtimeInfo.operatingSystem} {runtimeInfo.architecture} · Electron / Chromium</dd></div></dl><div className="about-actions"><button onClick={() => void platform.copyText(`Agent K ${version}\nPi ${runtimeInfo.piVersion}\n${runtimeInfo.operatingSystem} ${runtimeInfo.architecture}\n${navigator.userAgent}`)} type="button"><i className="fa-regular fa-copy" /> {t("copyDiagnostics")}</button><button onClick={() => void desktop.openExternalUrl("https://github.com/earendil-works/pi", settings.browserId)} type="button"><i className="fa-solid fa-arrow-up-right-from-square" /> {t("projectHomepage")}</button></div></>
            )}
          </main>
        </div>
        {editor && <div className="settings-subdialog"><div className="settings-subdialog-card">
          <h3>{editor === "local" ? t("localAdd") : t("providerAdd")}</h3>
          <label>{t("providerId")}<input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} /></label>
          <label>{t("displayName")}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>{t("baseUrl")}<input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
          <label>{t("apiProtocol")}<select value={draft.api} onChange={(e) => setDraft({ ...draft, api: e.target.value })}><option value="openai-completions">OpenAI Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
          <label>{t("apiKey")}<input autoComplete="off" type="password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} /></label>
          <label>{t("modelId")}<div className="inline-field"><input value={manualModel} onChange={(e) => {
            const value = e.target.value;
            setManualModel(value);
            const known = draft.models.find((model) => model.id === value);
            if (known) selectManualModel(known);
            else { setManualReasoning(false); setManualVision(false); setManualThinkingLevels([]); }
          }} /><button disabled={!draft.baseUrl || busy} onClick={() => void discoverLocal()} type="button">{t("discover")}</button></div></label>
          <label>{t("contextWindow")}<input min="1" onChange={(e) => setManualContextWindow(e.target.value)} placeholder="e.g. 524288" step="1" type="number" value={manualContextWindow} /><small>{t("contextWindowDetected")}</small></label>
          <label><span>{settings.locale === "en-US" ? "Vision input" : "视觉输入"}</span><span className="local-model-check"><input checked={manualVision} onChange={(event) => setManualVision(event.target.checked)} type="checkbox" /> {t("enabled")}</span><small>{settings.locale === "en-US" ? "Allows images to be attached to this model. Enable only when the serving backend loaded the model's vision components." : "允许向此模型附加图片；仅在推理服务已加载模型视觉组件时启用。"}</small></label>
          <label><span>{t("reasoning")}</span><span className="local-model-check"><input checked={manualReasoning} onChange={(event) => setManualReasoning(event.target.checked)} type="checkbox" /> {t("enabled")}</span><small>{t("reasoningDescription")}</small></label>
          <div aria-label={settings.locale === "en-US" ? "Supported reasoning levels" : "支持的推理等级"} className="discovered-models">
            {configurableThinkingLevels.map((level) => <button className={manualThinkingLevels.includes(level) ? "is-active" : undefined} key={level} onClick={() => {
              setManualThinkingLevels((current) => current.includes(level) ? current.filter((item) => item !== level) : [...current, level]);
              setManualReasoning(true);
            }} type="button">{level}</button>)}
          </div>
          {draft.models.length > 0 && <div className="discovered-models">{draft.models.map((model) => <button key={model.id} onClick={() => selectManualModel(model)} type="button">{model.id}{model.contextWindow ? ` · ${(model.contextWindow / 1024).toLocaleString()}K` : ""}</button>)}</div>}
          <footer><button onClick={() => setEditor(undefined)} type="button">{t("cancel")}</button><button className="primary-button" disabled={busy} onClick={() => void saveDraft()} type="button">{t("save")}</button></footer>
        </div></div>}
        {authTarget && <div className="settings-subdialog"><div className="settings-subdialog-card"><h3>{providerDisplayName(authTarget)} · {t("apiKey")}</h3><label>{t("apiKey")}<input autoComplete="off" autoFocus type="password" value={authKey} onChange={(event) => setAuthKey(event.target.value)} /></label><footer><button onClick={() => { setAuthTarget(undefined); setAuthKey(""); }} type="button">{t("cancel")}</button><button className="primary-button" disabled={busy || !authKey.trim()} onClick={() => void saveAuthKey()} type="button">{t("save")}</button></footer></div></div>}
        {pendingDelete && <div className="settings-subdialog"><div className="settings-subdialog-card"><h3>{t("delete")} {pendingDelete.name}?</h3><p className="settings-description">{pendingDelete.id} will be removed from models.json.</p><footer><button onClick={() => setPendingDelete(undefined)} type="button">{t("cancel")}</button><button className="danger-button" disabled={busy} onClick={() => void deleteProvider(pendingDelete)} type="button">{t("delete")}</button></footer></div></div>}
        {selectedSkill && <div className="settings-subdialog"><div className="settings-subdialog-card skill-details"><h3>{t("skillDetails")}</h3><dl><div><dt>{t("displayName")}</dt><dd>{selectedSkill.name}</dd></div><div><dt>{t("skillDescriptionLabel")}</dt><dd>{selectedSkill.description || t("noSkillDescription")}</dd></div><div><dt>{t("skillScopeLabel")}</dt><dd>{selectedSkill.scope === "project" ? t("projectScope") : t("userScope")}</dd></div><div><dt>{t("skillPathLabel")}</dt><dd>{selectedSkill.path}</dd></div></dl><footer><button className="primary-button" onClick={() => setSelectedSkill(undefined)} type="button">{t("close")}</button></footer></div></div>}
        {editorSkillViewer && <div className="settings-subdialog"><div className="settings-subdialog-card skill-hub-preview"><h3>{editorSkillViewer.name} · Editor Skill</h3><label>SKILL.md<textarea readOnly value={editorSkillViewer.source} /></label><footer><button className="primary-button" onClick={() => setEditorSkillViewer(undefined)} type="button">{t("close")}</button></footer></div></div>}
        {skillHubPreview && <div className="settings-subdialog"><div className="settings-subdialog-card skill-hub-preview"><h3>{t("skillHubReview")}</h3><div className="skill-hub-preview-meta"><strong>{skillHubPreview.name}</strong>{skillHubPreview.description && <span>{skillHubPreview.description}</span>}<small>{skillHubPreview.source} · {skillHubPreview.files.length} {t("skillHubFiles")}</small></div><label>{t("skillHubInstallScope")}<select disabled={!cwd} onChange={(event) => setSkillHubScope(event.target.value as SkillHubScope)} value={skillHubScope}><option value="project">{t("projectScope")}</option><option value="user">{t("userScope")}</option></select></label><div className="skill-hub-file-list">{skillHubPreview.files.map((file) => <span key={file.path}>{file.path}<small>{Math.ceil(file.bytes / 1024)} KB</small></span>)}</div><label>{t("skillHubContent")}<textarea readOnly value={skillHubPreview.skillMarkdown} /></label><footer><button onClick={() => setSkillHubPreview(undefined)} type="button">{t("cancel")}</button><button className="primary-button" disabled={busy || !cwd} onClick={() => void installSkill()} type="button">{t("skillHubInstall")}</button></footer></div></div>}
        {extensionPicker && <DirectoryPickerDialog
          acceptedFileExtensions={extensionPicker === "theme" ? [".json"] : [".zip"]}
          onCancel={() => setExtensionPicker(undefined)}
          onSelect={(path) => {
            const target = extensionPicker;
            setExtensionPicker(undefined);
            void (target === "editor" ? installEditorPlugin(path) : target === "language" ? installLanguagePack(path) : importTheme(path));
          }}
          selectFiles
          title={extensionPicker === "editor" ? "选择编辑器扩展文件" : extensionPicker === "language" ? "选择语言扩展文件" : t("themeFileDialog")}
        />}
      </section>
    </div>
  );
}
