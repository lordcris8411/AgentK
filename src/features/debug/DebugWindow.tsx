import { useEffect, useMemo, useState } from "react";
import { desktop } from "../../lib/desktop";
import { desktopWindow } from "../../lib/platform";
import { debugProviderIdentity, debugProviders, rankDebugProviders } from "./providers";
import { loadDebugProject, saveDebugProject } from "./persistence";
import { DebugPanel } from "./DebugPanel";

export function DebugWindow({ initialContextFile, initialRoot }: { initialContextFile?: string; initialRoot?: string }) {
  const [root, setRoot] = useState(initialRoot);
  const [contextFile, setContextFile] = useState(initialContextFile);
  const [error, setError] = useState<string>();
  const [plugins, setPlugins] = useState<Awaited<ReturnType<typeof desktop.listLanguagePacks>>>([]);
  const [selected, setSelected] = useState("");
  const providers = useMemo(() => rankDebugProviders(debugProviders(plugins), contextFile, root ? loadDebugProject(root).providerIdentity : undefined), [contextFile, plugins, root]);
  const provider = providers.find((item) => debugProviderIdentity(item) === selected) ?? providers[0];
  useEffect(() => {
    document.body.classList.add("is-native-debug-window");
    document.title = "Agent K — Debug";
    void desktop.listLanguagePacks().then(setPlugins).catch((cause) => setError(String(cause)));
    return () => document.body.classList.remove("is-native-debug-window");
  }, []);
  useEffect(() => desktopWindow.onDebugContext((context) => {
    setRoot(context.root);
    setContextFile(context.contextFile);
    setError(undefined);
  }), []);
  useEffect(() => desktopWindow.onDebugRoot((next) => { setRoot(next); setError(undefined); }), []);
  useEffect(() => desktopWindow.onDebugProviderHit((packId) => {
    const hitProvider = providers.find((item) => item.packId === packId);
    if (hitProvider) setSelected(debugProviderIdentity(hitProvider));
  }), [providers]);
  useEffect(() => {
    if (!provider) return;
    const identity = debugProviderIdentity(provider);
    setSelected(identity);
    if (root) {
      const saved = loadDebugProject(root);
      if (saved.providerIdentity !== identity) saveDebugProject(root, { ...saved, providerIdentity: identity });
    }
  }, [provider, root]);
  return <main className="native-debug-window">
    {providers.length ? <div className="debug-provider-bar">
      <span>调试目标</span>
      <select aria-label="Debug provider" onChange={(event) => setSelected(event.target.value)} value={provider ? debugProviderIdentity(provider) : ""}>
        {providers.map((item) => <option key={debugProviderIdentity(item)} value={debugProviderIdentity(item)}>{item.label} · {item.packId}</option>)}
      </select>
      {contextFile ? <small title={contextFile}>{contextFile.split(/[/\\]/u).pop()}</small> : null}
    </div> : null}
    {provider ? <DebugPanel contextFile={contextFile} packId={provider.packId} modes={provider.modes} onError={setError} providerId={provider.id} root={root} />
      : <div className="debug-provider-empty">当前没有已启用的调试 Provider。</div>}
    {error ? <div className="native-debug-window-error" role="alert">{error}</div> : null}
  </main>;
}
