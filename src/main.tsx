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

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Application root was not found");
}

// WebKitGTK pays a noticeably higher price than WebView2 for backdrop filters
// and layout animations. Expose the host platform to CSS so Linux can use a
// visually equivalent, less compositing-heavy profile.
const platform = navigator.userAgent.includes("Linux")
  ? "linux"
  : navigator.userAgent.includes("Windows")
    ? "windows"
    : "other";
document.documentElement.dataset.platform = platform;
installDampedWheelScrolling();

createRoot(rootElement).render(
  <StrictMode>
    <SettingsProvider>
      <ExtensionUiProvider>
        <App />
      </ExtensionUiProvider>
    </SettingsProvider>
  </StrictMode>,
);
