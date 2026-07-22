import { defineEditor } from "../../sdk";
import "./editor.css";

function displayBytes(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

defineEditor((host, initial) => {
  if (!initial.binary) throw new Error("The video plugin requires binary file data");
  document.documentElement.dataset.theme = initial.theme;
  const url = URL.createObjectURL(new Blob([initial.binary], { type: initial.mimeType }));
  host.root.className = "video-editor";
  const stage = document.createElement("main");
  stage.className = "video-stage";
  const player = document.createElement("video");
  player.controls = true;
  player.preload = "metadata";
  player.src = url;
  stage.append(player);
  const info = document.createElement("footer");
  info.className = "video-info";
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
  };
});
