import { useEffect, useMemo, useRef, useState } from "react";
import {
  desktop,
  type BrowserOption,
  type FileFormatPluginResource,
  type ProviderCatalogItem,
  type ProviderDraft,
  type PiResource,
  type PiResourceChange,
  type RuntimeInfo,
  type SkillHubPreview,
  type SkillHubScope,
} from "../../lib/desktop";
import { useSettings } from "./SettingsContext";
import { platform } from "../../lib/platform";

export type SettingsPage = "models" | "appearance" | "agentSettings" | "skills" | "extensions" | "editors" | "permissions" | "about";

let aboutDataPromise: Promise<[string, RuntimeInfo]> | undefined;
let browserDataPromise: Promise<BrowserOption[]> | undefined;

const featuredSkills = [
  {
    name: "Find Skills",
    description: "Vercel Labs 的技能发现助手",
    sourceUrl: "https://github.com/vercel-labs/skills/tree/main/skills/find-skills",
  },
];

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
  initialPage = "models",
  cwd,
  runtimeId,
  sessionId,
}: {
  open: boolean;
  onClose(changes: PiResourceChange[], editorSettingsChanged: boolean): void;
  initialPage?: SettingsPage;
  cwd?: string;
  runtimeId?: string;
  sessionId?: string;
}) {
  const { settings, update, t } = useSettings();
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
  const [providers, setProviders] = useState<ProviderCatalogItem[]>([]);
  const [models, setModels] = useState<Array<{ provider: string; id: string; name?: string }>>([]);
  const [state, setState] = useState<{ model?: { provider: string; id: string }; thinkingLevel?: string }>({});
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
  const [pendingDelete, setPendingDelete] = useState<ProviderCatalogItem>();
  const [skillHubUrl, setSkillHubUrl] = useState("");
  const [skillHubPreview, setSkillHubPreview] = useState<SkillHubPreview>();
  const [skillHubScope, setSkillHubScope] = useState<SkillHubScope>(cwd ? "project" : "user");
  const [selectedSkill, setSelectedSkill] = useState<PiResource>();
  const [authTarget, setAuthTarget] = useState<ProviderCatalogItem>();
  const [authKey, setAuthKey] = useState("");
  const [notice, setNotice] = useState<string>();
  const [version, setVersion] = useState("0.1.0");
  const [runtimeInfo, setRuntimeInfo] = useState({ piVersion: "unknown", operatingSystem: navigator.platform, architecture: "" });
  const [browsers, setBrowsers] = useState<BrowserOption[]>([
    { id: "default", name: "System default" },
  ]);
  const providersRef = useRef<ProviderCatalogItem[]>([]);
  const lastCatalogRefreshRef = useRef(0);
  const providerDisplayName = (provider: Pick<ProviderCatalogItem, "id" | "name">) =>
    provider.id === "ollama" ? "Ollama" : provider.id === "vllm" ? "vLLM" : provider.name || provider.id;
  const discoverLocal = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const service = await desktop.detectLocalService(draft.baseUrl);
      const found = await desktop.discoverModels(draft.baseUrl, service.kind === "ollama");
      setDraft((current) => ({
        ...current,
        id: service.kind === "openai-compatible" ? current.id : service.kind,
        name: service.kind === "openai-compatible" ? current.name : service.displayName,
        apiKey: service.kind === "ollama" ? "ollama" : current.apiKey || "local",
        models: found,
      }));
      if (found[0]) setManualModel(found[0]);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async (forceCatalog = true) => {
    setBusy(true);
    setError(undefined);
    try {
      const refreshCatalog = forceCatalog
        || providersRef.current.length === 0
        || Date.now() - lastCatalogRefreshRef.current > 30_000;
      const [catalog, current] = await Promise.all([
        refreshCatalog
          ? desktop.providerCatalog()
          : Promise.resolve(providersRef.current),
        desktop.command({ type: "get_state" }) as Promise<typeof state>,
      ]);
      if (refreshCatalog) {
        providersRef.current = catalog;
        lastCatalogRefreshRef.current = Date.now();
        setProviders(catalog);
      }
      const seen = new Set<string>();
      setModels(catalog.flatMap((provider) => provider.models
        .filter((model) => {
          const key = `${provider.id}/${model.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((model) => ({ ...model, provider: provider.id }))));
      setState(current);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
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
    if (!cwd) setSkillHubScope("user");
  }, [cwd]);
  useEffect(() => {
    if (!open || !["skills", "extensions", "editors"].includes(page) || !runtimeId || !cwd) return;
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
    if (!open || page !== "editors") return;
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
    if (!open || !["skills", "extensions", "editors"].includes(page)) return;
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
    // Let the dialog shell paint before asking Pi for model data. Reopening
    // within the cache window only refreshes the small runtime state payload.
    let timeout: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      timeout = window.setTimeout(() => void refresh(false), 0);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [open, page]);
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
  const modelValue = state.model ? `${state.model.provider}/${state.model.id}` : "";
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
    const custom = providers.filter((item) => item.source === "custom");
    const builtIn = providers.filter((item) => item.source !== "custom");
    return { custom, builtIn };
  }, [providers]);
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
      await desktop.reloadPiRuntimes();
      setAuthTarget(undefined);
      setAuthKey("");
      await refresh();
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
      await desktop.reloadPiRuntimes();
      await refresh();
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
      await desktop.reloadPiRuntimes();
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const saveDraft = async () => {
    const ids = [...draft.models, manualModel.trim()].filter(Boolean);
    if (!draft.id.trim() || !draft.baseUrl.trim() || ids.length === 0) {
      setError("Provider ID、Base URL 和至少一个模型 ID 为必填项");
      return;
    }
    setBusy(true);
    try {
      await desktop.saveProvider({ ...draft, models: [...new Set(ids)] });
      if (draft.apiKey) {
        await desktop.saveProviderApiKey(draft.id, draft.apiKey);
      }
      await desktop.reloadPiRuntimes();
      setEditor(undefined);
      setManualModel("");
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
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
            {(["models", "appearance", "agentSettings", "skills", "extensions", "editors", "permissions", "about"] as SettingsPage[]).map((item) => (
              <button className={page === item ? "is-active" : ""} key={item} onClick={() => setPage(item)} type="button">
                <i className={`fa-solid ${item === "models" ? "fa-microchip" : item === "appearance" ? "fa-circle-half-stroke" : item === "agentSettings" ? "fa-sliders" : item === "skills" ? "fa-wand-magic-sparkles" : item === "extensions" ? "fa-puzzle-piece" : item === "editors" ? "fa-pen-ruler" : item === "permissions" ? "fa-shield-halved" : "fa-circle-info"}`} />
                {t(item)}
              </button>
            ))}
          </nav>
          <main className="settings-content">
            {error && <p className="settings-error">{error}</p>}
            {notice && <p className="settings-description">{notice}</p>}
            {page === "appearance" && (
              <>
                <h2>{t("appearance")}</h2>
                <div className="settings-section">
                  <label>{t("appearance")}</label>
                  <div className="segmented-control">
                    <button className={settings.theme === "light" ? "is-active" : ""} onClick={() => void update({ theme: "light" })} type="button"><i className="fa-regular fa-sun" /> {t("light")}</button>
                    <button className={settings.theme === "dark" ? "is-active" : ""} onClick={() => void update({ theme: "dark" })} type="button"><i className="fa-regular fa-moon" /> {t("dark")}</button>
                    <button className={settings.theme === "system" ? "is-active" : ""} onClick={() => void update({ theme: "system" })} type="button"><i className="fa-solid fa-desktop" /> {t("systemTheme")}</button>
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
                          <small title={plugin.path}>{plugin.id} · {plugin.path}</small>
                          <span>{t("builtIn")} · {plugin.editor}</span>
                        </div>
                        <div className="resource-card-actions">
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
                          <small>{resource.description || resource.path}</small>
                          <span>{resource.scope === "project" ? t("projectScope") : t("userScope")} · {resource.path}</span>
                        </div>
                        <div className="resource-card-actions">
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
            {page === "models" && (
              <>
                <div className="settings-title-row"><h2>{t("models")}</h2><button disabled={busy} onClick={() => void reloadProviders()} type="button"><i className="fa-solid fa-rotate" /> {t("refresh")}</button></div>
                <div className="model-current-row">
                  <label>{t("currentModel")}<select value={modelValue} onChange={(event) => { const [provider, ...rest] = event.target.value.split("/"); void desktop.command({ type: "set_model", provider, modelId: rest.join("/") }).then(() => { window.dispatchEvent(new Event("agent-k-model-changed")); return refresh(); }); }}><option value="">—</option>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name ?? model.id} · {model.provider === "ollama" ? "Ollama" : model.provider === "vllm" ? "vLLM" : model.provider}</option>)}</select></label>
                  <label>{t("thinking")}<select value={state.thinkingLevel ?? "off"} onChange={(event) => void desktop.command({ type: "set_thinking_level", level: event.target.value }).then(() => refresh())}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level}>{level}</option>)}</select></label>
                </div>
                {providers.length > 0 && <div className="provider-actions"><button onClick={() => { setDraft({ id: "", name: "", baseUrl: "https://", api: "openai-completions", apiKey: "", models: [], local: false }); setEditor("provider"); }} type="button"><i className="fa-solid fa-plus" /> {t("providerAdd")}</button><button onClick={() => { setDraft({ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [], local: true }); setEditor("local"); }} type="button"><i className="fa-solid fa-desktop" /> {t("localAdd")}</button></div>}
                {[...grouped.custom, ...grouped.builtIn].map((provider) => (
                  <article className="provider-card" key={provider.id}><div><strong>{providerDisplayName(provider)}</strong><small>{provider.id} · {provider.models.length} models</small></div><span className={provider.configured ? "provider-status is-ready" : "provider-status"}>{provider.configured ? t("configured") : t("notConfigured")}</span><div className="provider-card-actions">{provider.source === "custom" && <button aria-label="Edit" onClick={() => { setDraft({ id: provider.id, name: providerDisplayName(provider), baseUrl: provider.baseUrl ?? "", api: provider.api ?? "openai-completions", apiKey: "", models: provider.models.map((model) => model.id), local: provider.baseUrl?.includes("localhost") ?? false }); setManualModel(provider.models[0]?.id ?? ""); setEditor("provider"); }} type="button"><i className="fa-regular fa-pen-to-square" /></button>}{provider.authMethods.includes("api_key") && <button disabled={busy} onClick={() => void authenticate(provider, "api_key")} type="button">{t("apiKey")}</button>}{provider.authMethods.includes("oauth") && <button disabled={busy} onClick={() => void authenticate(provider, "oauth")} type="button">{t("oauth")}</button>}{provider.configured && <button disabled={busy} onClick={() => void logout(provider)} type="button">{t("logout")}</button>}{provider.source === "custom" && <button aria-label={t("delete")} onClick={() => setPendingDelete(provider)} type="button"><i className="fa-regular fa-trash-can" /></button>}</div></article>
                ))}
                {!busy && providers.length === 0 && <p className="empty-settings">{t("noProviders")}</p>}
              </>
            )}
            {page === "about" && (
              <><div className="about-brand"><span className="brand-mark">K</span><div><h2>Agent K</h2><p>Visual desktop client for Pi</p></div></div><dl className="about-list"><div><dt>{t("appVersion")}</dt><dd>{version}</dd></div><div><dt>{t("piVersion")}</dt><dd>{runtimeInfo.piVersion}</dd></div><div><dt>{t("systemInfo")}</dt><dd>{runtimeInfo.operatingSystem} {runtimeInfo.architecture} · Electron / Chromium</dd></div></dl><div className="about-actions"><button onClick={() => void navigator.clipboard.writeText(`Agent K ${version}\nPi ${runtimeInfo.piVersion}\n${runtimeInfo.operatingSystem} ${runtimeInfo.architecture}\n${navigator.userAgent}`)} type="button"><i className="fa-regular fa-copy" /> {t("copyDiagnostics")}</button><button onClick={() => void desktop.openExternalUrl("https://github.com/earendil-works/pi", settings.browserId)} type="button"><i className="fa-solid fa-arrow-up-right-from-square" /> {t("projectHomepage")}</button></div></>
            )}
          </main>
        </div>
        {editor && <div className="settings-subdialog"><div className="settings-subdialog-card"><h3>{editor === "local" ? t("localAdd") : t("providerAdd")}</h3><label>{t("providerId")}<input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} /></label><label>{t("displayName")}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>{t("baseUrl")}<input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label><label>{t("apiProtocol")}<select value={draft.api} onChange={(e) => setDraft({ ...draft, api: e.target.value })}><option value="openai-completions">OpenAI Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label><label>{t("apiKey")}<input autoComplete="off" type="password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} /></label><label>{t("modelId")}<div className="inline-field"><input value={manualModel} onChange={(e) => setManualModel(e.target.value)} /><button disabled={!draft.baseUrl || busy} onClick={() => void discoverLocal()} type="button">{t("discover")}</button></div></label>{draft.models.length > 0 && <div className="discovered-models">{draft.models.map((id) => <button key={id} onClick={() => setManualModel(id)} type="button">{id}</button>)}</div>}<footer><button onClick={() => setEditor(undefined)} type="button">{t("cancel")}</button><button className="primary-button" disabled={busy} onClick={() => void saveDraft()} type="button">{t("save")}</button></footer></div></div>}
        {authTarget && <div className="settings-subdialog"><div className="settings-subdialog-card"><h3>{providerDisplayName(authTarget)} · {t("apiKey")}</h3><label>{t("apiKey")}<input autoComplete="off" autoFocus type="password" value={authKey} onChange={(event) => setAuthKey(event.target.value)} /></label><footer><button onClick={() => { setAuthTarget(undefined); setAuthKey(""); }} type="button">{t("cancel")}</button><button className="primary-button" disabled={busy || !authKey.trim()} onClick={() => void saveAuthKey()} type="button">{t("save")}</button></footer></div></div>}
        {pendingDelete && <div className="settings-subdialog"><div className="settings-subdialog-card"><h3>{t("delete")} {pendingDelete.name}?</h3><p className="settings-description">{pendingDelete.id} will be removed from models.json.</p><footer><button onClick={() => setPendingDelete(undefined)} type="button">{t("cancel")}</button><button className="danger-button" onClick={() => { setBusy(true); void desktop.deleteProvider(pendingDelete.id).then(() => desktop.reloadPiRuntimes()).then(() => refresh()).catch((cause) => setError(String(cause))).finally(() => { setPendingDelete(undefined); setBusy(false); }); }} type="button">{t("delete")}</button></footer></div></div>}
        {selectedSkill && <div className="settings-subdialog"><div className="settings-subdialog-card skill-details"><h3>{t("skillDetails")}</h3><dl><div><dt>{t("displayName")}</dt><dd>{selectedSkill.name}</dd></div><div><dt>{t("skillDescriptionLabel")}</dt><dd>{selectedSkill.description || t("noSkillDescription")}</dd></div><div><dt>{t("skillScopeLabel")}</dt><dd>{selectedSkill.scope === "project" ? t("projectScope") : t("userScope")}</dd></div><div><dt>{t("skillPathLabel")}</dt><dd>{selectedSkill.path}</dd></div></dl><footer><button className="primary-button" onClick={() => setSelectedSkill(undefined)} type="button">{t("close")}</button></footer></div></div>}
        {skillHubPreview && <div className="settings-subdialog"><div className="settings-subdialog-card skill-hub-preview"><h3>{t("skillHubReview")}</h3><div className="skill-hub-preview-meta"><strong>{skillHubPreview.name}</strong>{skillHubPreview.description && <span>{skillHubPreview.description}</span>}<small>{skillHubPreview.source} · {skillHubPreview.files.length} {t("skillHubFiles")}</small></div><label>{t("skillHubInstallScope")}<select disabled={!cwd} onChange={(event) => setSkillHubScope(event.target.value as SkillHubScope)} value={skillHubScope}><option value="project">{t("projectScope")}</option><option value="user">{t("userScope")}</option></select></label><div className="skill-hub-file-list">{skillHubPreview.files.map((file) => <span key={file.path}>{file.path}<small>{Math.ceil(file.bytes / 1024)} KB</small></span>)}</div><label>{t("skillHubContent")}<textarea readOnly value={skillHubPreview.skillMarkdown} /></label><footer><button onClick={() => setSkillHubPreview(undefined)} type="button">{t("cancel")}</button><button className="primary-button" disabled={busy || !cwd} onClick={() => void installSkill()} type="button">{t("skillHubInstall")}</button></footer></div></div>}
      </section>
    </div>
  );
}
