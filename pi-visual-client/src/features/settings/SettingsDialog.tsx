import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  desktop,
  type BrowserOption,
  type ProviderCatalogItem,
  type ProviderDraft,
} from "../../lib/desktop";
import { useSettings } from "./SettingsContext";
import { useExtensionUi } from "../extensions/ExtensionUiContext";

type Page = "models" | "appearance" | "agentSettings" | "permissions" | "about";
export function SettingsDialog({
  open,
  onClose,
  sessionId,
}: {
  open: boolean;
  onClose(): void;
  sessionId?: string;
}) {
  const { settings, update, t } = useSettings();
  const { ready: extensionUiReady } = useExtensionUi();
  const [page, setPage] = useState<Page>("models");
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
  const [version, setVersion] = useState("0.1.0");
  const [runtimeInfo, setRuntimeInfo] = useState({ piVersion: "unknown", operatingSystem: navigator.platform, architecture: "" });
  const [browsers, setBrowsers] = useState<BrowserOption[]>([
    { id: "default", name: "System default" },
  ]);
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
  const refresh = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const [catalog, available, current] = await Promise.all([
        desktop.command({ type: "get_provider_catalog" }) as Promise<{ providers?: ProviderCatalogItem[] }>,
        desktop.command({ type: "get_available_models" }) as Promise<{ models?: Array<{ provider: string; id: string; name?: string }> }>,
        desktop.command({ type: "get_state" }) as Promise<typeof state>,
      ]);
      setProviders(catalog.providers ?? []);
      setModels(available.models ?? []);
      setState(current);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    void getVersion().then(setVersion).catch(() => undefined);
    void desktop.runtimeInfo().then(setRuntimeInfo).catch(() => undefined);
    void desktop.listBrowsers().then(setBrowsers).catch(() => undefined);
    void refresh();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    return () => {
      void desktop.command({ type: "cancel_login" }).catch(() => undefined);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);
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
    setBusy(true);
    setError(undefined);
    try {
      await desktop.command({ type: "login_provider", providerId: provider.id, authType });
      await refresh();
    } catch (cause) {
      setError(String(cause));
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
      await desktop.command({ type: "reload_models" });
      if (draft.apiKey) {
        await desktop.command({
          type: "login_provider",
          providerId: draft.id,
          authType: "api_key",
          value: draft.apiKey,
        });
      }
      setEditor(undefined);
      setManualModel("");
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section aria-label={t("settings")} aria-modal="true" className="settings-dialog" role="dialog">
        <header className="settings-header">
          <strong>{t("settings")}</strong>
          <button aria-label={t("close")} className="settings-close" onClick={onClose} type="button">×</button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav">
            {(["models", "appearance", "agentSettings", "permissions", "about"] as Page[]).map((item) => (
              <button className={page === item ? "is-active" : ""} key={item} onClick={() => setPage(item)} type="button">
                <i className={`fa-solid ${item === "models" ? "fa-microchip" : item === "appearance" ? "fa-circle-half-stroke" : item === "agentSettings" ? "fa-sliders" : item === "permissions" ? "fa-shield-halved" : "fa-circle-info"}`} />
                {t(item)}
              </button>
            ))}
          </nav>
          <main className="settings-content">
            {error && <p className="settings-error">{error}</p>}
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
            {page === "models" && (
              <>
                <div className="settings-title-row"><h2>{t("models")}</h2><button disabled={busy} onClick={() => void refresh()} type="button"><i className="fa-solid fa-rotate" /> {t("refresh")}</button></div>
                <div className="model-current-row">
                  <label>{t("currentModel")}<select value={modelValue} onChange={(event) => { const [provider, ...rest] = event.target.value.split("/"); void desktop.command({ type: "set_model", provider, modelId: rest.join("/") }).then(() => { window.dispatchEvent(new Event("agent-k-model-changed")); return refresh(); }); }}><option value="">—</option>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name ?? model.id} · {model.provider === "ollama" ? "Ollama" : model.provider === "vllm" ? "vLLM" : model.provider}</option>)}</select></label>
                  <label>{t("thinking")}<select value={state.thinkingLevel ?? "off"} onChange={(event) => void desktop.command({ type: "set_thinking_level", level: event.target.value }).then(refresh)}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level}>{level}</option>)}</select></label>
                </div>
                <div className="provider-actions"><button onClick={() => { setDraft({ id: "", name: "", baseUrl: "https://", api: "openai-completions", apiKey: "", models: [], local: false }); setEditor("provider"); }} type="button"><i className="fa-solid fa-plus" /> {t("providerAdd")}</button><button onClick={() => { setDraft({ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [], local: true }); setEditor("local"); }} type="button"><i className="fa-solid fa-desktop" /> {t("localAdd")}</button></div>
                {[...grouped.custom, ...grouped.builtIn].map((provider) => (
                  <article className="provider-card" key={provider.id}><div><strong>{providerDisplayName(provider)}</strong><small>{provider.id} · {provider.models.length} models</small></div><span className={provider.configured ? "provider-status is-ready" : "provider-status"}>{provider.configured ? t("configured") : t("notConfigured")}</span><div className="provider-card-actions">{provider.source === "custom" && <button aria-label="Edit" onClick={() => { setDraft({ id: provider.id, name: providerDisplayName(provider), baseUrl: provider.baseUrl ?? "", api: provider.api ?? "openai-completions", apiKey: "", models: provider.models.map((model) => model.id), local: provider.baseUrl?.includes("localhost") ?? false }); setManualModel(provider.models[0]?.id ?? ""); setEditor("provider"); }} type="button"><i className="fa-regular fa-pen-to-square" /></button>}{provider.authMethods.includes("api_key") && <button disabled={busy || !extensionUiReady} onClick={() => void authenticate(provider, "api_key")} type="button">{t("apiKey")}</button>}{provider.authMethods.includes("oauth") && <button disabled={busy || !extensionUiReady} onClick={() => void authenticate(provider, "oauth")} type="button">{t("oauth")}</button>}{provider.configured && <button disabled={busy} onClick={() => void desktop.command({ type: "logout_provider", providerId: provider.id }).then(refresh)} type="button">{t("logout")}</button>}{provider.source === "custom" && <button aria-label={t("delete")} onClick={() => setPendingDelete(provider)} type="button"><i className="fa-regular fa-trash-can" /></button>}</div></article>
                ))}
                {!busy && providers.length === 0 && <p className="empty-settings">{t("noProviders")}</p>}
              </>
            )}
            {page === "about" && (
              <><div className="about-brand"><span className="brand-mark">K</span><div><h2>Agent K</h2><p>Visual desktop client for Pi</p></div></div><dl className="about-list"><div><dt>{t("appVersion")}</dt><dd>{version}</dd></div><div><dt>{t("piVersion")}</dt><dd>{runtimeInfo.piVersion}</dd></div><div><dt>{t("systemInfo")}</dt><dd>{runtimeInfo.operatingSystem} {runtimeInfo.architecture} · {navigator.userAgent.includes("WebView") ? "WebView2" : "WebView"}</dd></div></dl><div className="about-actions"><button onClick={() => void navigator.clipboard.writeText(`Agent K ${version}\nPi ${runtimeInfo.piVersion}\n${runtimeInfo.operatingSystem} ${runtimeInfo.architecture}\n${navigator.userAgent}`)} type="button"><i className="fa-regular fa-copy" /> {t("copyDiagnostics")}</button><button onClick={() => void desktop.openExternalUrl("https://github.com/earendil-works/pi", settings.browserId)} type="button"><i className="fa-solid fa-arrow-up-right-from-square" /> {t("projectHomepage")}</button></div></>
            )}
          </main>
        </div>
        {editor && <div className="settings-subdialog"><div className="settings-subdialog-card"><h3>{editor === "local" ? t("localAdd") : t("providerAdd")}</h3><label>{t("providerId")}<input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} /></label><label>{t("displayName")}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>{t("baseUrl")}<input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label><label>{t("apiProtocol")}<select value={draft.api} onChange={(e) => setDraft({ ...draft, api: e.target.value })}><option value="openai-completions">OpenAI Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label><label>{t("apiKey")}<input autoComplete="off" type="password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} /></label><label>{t("modelId")}<div className="inline-field"><input value={manualModel} onChange={(e) => setManualModel(e.target.value)} /><button disabled={!draft.baseUrl || busy} onClick={() => void discoverLocal()} type="button">{t("discover")}</button></div></label>{draft.models.length > 0 && <div className="discovered-models">{draft.models.map((id) => <button key={id} onClick={() => setManualModel(id)} type="button">{id}</button>)}</div>}<footer><button onClick={() => setEditor(undefined)} type="button">{t("cancel")}</button><button className="primary-button" disabled={busy} onClick={() => void saveDraft()} type="button">{t("save")}</button></footer></div></div>}
        {pendingDelete && <div className="settings-subdialog"><div className="settings-subdialog-card"><h3>{t("delete")} {pendingDelete.name}?</h3><p className="settings-description">{pendingDelete.id} will be removed from models.json.</p><footer><button onClick={() => setPendingDelete(undefined)} type="button">{t("cancel")}</button><button className="danger-button" onClick={() => { setBusy(true); void desktop.deleteProvider(pendingDelete.id).then(() => desktop.command({ type: "reload_models" })).then(refresh).finally(() => { setPendingDelete(undefined); setBusy(false); }); }} type="button">{t("delete")}</button></footer></div></div>}
      </section>
    </div>
  );
}
