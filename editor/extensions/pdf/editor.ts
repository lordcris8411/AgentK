import { defineEditor, type EditorThemeConfig } from "../../sdk";
import "./editor.css";

function applyThemeConfig(config?: EditorThemeConfig): void {
  const style = document.documentElement.style;
  const background = config?.colors["surface-panel"];
  if (background) style.setProperty("--pdf-background", background);
  else style.removeProperty("--pdf-background");
}

defineEditor((host, initial) => {
  if (!initial.binary) throw new Error("The PDF plugin requires binary file data");
  document.documentElement.dataset.theme = initial.theme;
  applyThemeConfig(initial.themeConfig);
  const url = URL.createObjectURL(new Blob([initial.binary], { type: "application/pdf" }));
  host.root.className = "pdf-editor";
  const frame = document.createElement("iframe");
  frame.className = "pdf-frame";
  frame.src = url;
  frame.title = initial.fileName;
  host.root.append(frame);

  return {
    dispose() {
      URL.revokeObjectURL(url);
    },
    getContent: () => "",
    setContent: () => undefined,
    setTheme(theme) {
      document.documentElement.dataset.theme = theme;
    },
    setThemeConfig: applyThemeConfig,
  };
});
