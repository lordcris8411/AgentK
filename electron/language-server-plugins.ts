import type { LanguageServerPluginManifest } from "./language-server-host.js";

/** Built-in native plugins use the same manifest contract as future add-ons. */
export const cppClangdLanguagePlugin: LanguageServerPluginManifest = {
  apiVersion: 1,
  displayName: "clangd",
  id: "cpp-clangd",
  languages: ["c", "cpp"],
  projectMarkers: ["CMakeLists.txt", "compile_commands.json"],
  projectMenu: { loadLabel: "加载 C++ 工程", unloadLabel: "卸载 C++ 工程" },
  editorContribution: { id: "cpp-project", name: "C++ project", description: "CMake project loading, clangd code intelligence, diagnostics and navigation.", version: "1.0.0", editorPluginId: "agent-k.text" },
  skill: { name: "C++ project language service", markdown: "---\nname: cpp-project-language-service\ndescription: Use the managed clangd service for loaded C++ projects.\n---\n\n# C++ project language service\n\nUse the C++ project service for navigation, diagnostics, references and code intelligence. Load a CMake project before relying on semantic results. The managed toolchain and build database are isolated from the user project.\n" },
  commands: [{ id: "active-cpp-projects", title: "Active C++ projects", kind: "project-manager" }],
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
