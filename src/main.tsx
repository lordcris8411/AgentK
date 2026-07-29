import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fortawesome/fontawesome-free/css/fontawesome.min.css";
import "@fortawesome/fontawesome-free/css/regular.min.css";
import "@fortawesome/fontawesome-free/css/solid.min.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "katex/dist/katex.min.css";
import "./styles/theme.css";
import { SettingsProvider } from "./features/settings/SettingsContext";
import { ExtensionUiProvider } from "./features/extensions/ExtensionUiContext";
import { installDampedWheelScrolling } from "./lib/dampedScrolling";
import { DebugWindow } from "./features/debug/DebugWindow";
import { DebugToolWindow, type DebugToolKind } from "./features/debug/DebugToolWindow";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Application root was not found");
}

const parameters = new URLSearchParams(window.location.search);
const windowKind = parameters.get("window");
const debugTool = parameters.get("tool") as DebugToolKind | null;

installDampedWheelScrolling();

createRoot(rootElement).render(
  <StrictMode>
    <SettingsProvider>
      {windowKind === "debug"
        ? <DebugWindow initialContextFile={parameters.get("context-file") ?? undefined} initialRoot={parameters.get("root") ?? undefined} />
        : windowKind === "debug-tool" && (debugTool === "memory" || debugTool === "registers" || debugTool === "disassembly")
          ? <DebugToolWindow initialLanguageServerId={parameters.get("language-server") ?? ""} initialRoot={parameters.get("root") ?? undefined} initialSessionId={parameters.get("session-id") ?? undefined} initialTarget={parameters.get("target") ?? undefined} kind={debugTool} />
        : <ExtensionUiProvider><App /></ExtensionUiProvider>}
    </SettingsProvider>
  </StrictMode>,
);
