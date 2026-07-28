import { defineEditor, type EditorThemeConfig } from "../../sdk";
import "./editor.css";

function displayBytes(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function applyThemeConfig(config?: EditorThemeConfig): void {
  const style = document.documentElement.style;
  const set = (name: string, value?: string) => value
    ? style.setProperty(name, value)
    : style.removeProperty(name);
  set("--audio-background", config?.colors["surface-panel"]);
  set("--audio-border", config?.colors["border-color"]);
  set("--audio-text", config?.colors["text-primary"]);
  set("--audio-muted", config?.colors["text-secondary"]);
  set("--audio-card", config?.colors["surface-raised"]);
  set("--audio-accent", config?.colors.accent);
  set("--audio-ui-font", config?.fonts?.ui);
}

defineEditor((host, initial) => {
  if (!initial.binary) throw new Error("The audio plugin requires binary file data");
  document.documentElement.dataset.theme = initial.theme;
  applyThemeConfig(initial.themeConfig);
  const url = URL.createObjectURL(new Blob([initial.binary], { type: initial.mimeType }));
  host.root.className = "audio-editor";
  const stage = document.createElement("main");
  stage.className = "audio-stage";
  const player = document.createElement("audio");
  player.controls = true;
  player.preload = "metadata";
  player.src = url;
  stage.append(player);
  const info = document.createElement("footer");
  info.className = "audio-info";
  info.textContent = `${initial.fileName} · ${initial.codec ?? initial.mimeType} · ${displayBytes(initial.byteSize)}`;
  host.root.append(stage, info);

  return {
    dispose() {
      player.pause();
      URL.revokeObjectURL(url);
    },
    executeAction(action, parameters) {
      if (action === "play") void player.play();
      else if (action === "pause") player.pause();
      else if (action === "seek" && typeof parameters.seconds === "number")
        player.currentTime = Math.max(0, Math.min(player.duration || 0, player.currentTime + parameters.seconds));
    },
    getContent: () => "",
    setContent: () => undefined,
    setTheme(theme) {
      document.documentElement.dataset.theme = theme;
    },
    setThemeConfig: applyThemeConfig,
  };
});
