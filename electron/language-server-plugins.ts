import type { LanguageServerPluginManifest } from "./language-server-host.js";

/** Built-in native plugins use the same manifest contract as future add-ons. */
export const cppClangdLanguagePlugin: LanguageServerPluginManifest = {
  apiVersion: 1,
  id: "cpp-clangd",
  languages: ["c", "cpp"],
  projectMarkers: ["CMakeLists.txt", "compile_commands.json"],
  worker: new URL("./cpp-service.js", import.meta.url),
  // Reserved capability only. Debug adapters will be driven through DAP once
  // the debug-server worker protocol is implemented.
  debugServer: {
    adapters: [
      { command: "windbg", platforms: ["win32"] },
      { command: "lldb", platforms: ["linux", "darwin"] },
      { command: "gdb", platforms: ["linux", "darwin"] },
    ],
    protocol: "dap",
  },
};
