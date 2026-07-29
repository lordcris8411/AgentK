export type ToolchainArchive = {
  asset: string;
  owner: string;
  repository: string;
  sha256: string;
  tag: string;
};

/** Portable LLDB DAP distribution used only by the trusted debug worker. */
export function managedDebuggerArchive(platform: NodeJS.Platform, architecture: string): ToolchainArchive | undefined {
  const common = { owner: "vadimcn", repository: "codelldb", tag: "v1.12.2" };
  if (platform === "linux" && architecture === "x64")
    return { ...common, asset: "codelldb-linux-x64.vsix", sha256: "b85b45a8570051d535b0927c6c9da11c39f3a056c73559064647faf7f37f637d" };
  if (platform === "darwin" && architecture === "x64")
    return { ...common, asset: "codelldb-darwin-x64.vsix", sha256: "8270a342929bdc0deb6d7d3931c08d5ba6018265f840dd0508c4247fb8d32e8d" };
  if (platform === "darwin" && architecture === "arm64")
    return { ...common, asset: "codelldb-darwin-arm64.vsix", sha256: "c836b81c6f2da467b5920a376a7bfc849dc4b4d81b19779dedf1c685cb4aa1a0" };
  return undefined;
}

export function managedDebuggerMarker(platform: NodeJS.Platform, architecture: string): string | undefined {
  const archive = managedDebuggerArchive(platform, architecture);
  return archive ? `codelldb:${archive.asset}:${archive.sha256}\n` : undefined;
}

export const DEFAULT_VSWHERE_PATH = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";

export type ManagedToolchainArchives = {
  clangd: ToolchainArchive;
  cmake: ToolchainArchive;
  ninja: ToolchainArchive;
};

/** Language support only needs clangd. CMake uses the compiler installed for
 * the project instead of downloading an incomplete platform toolchain. */
export function managedToolchainArchives(platform: "linux" | "win32"): ManagedToolchainArchives {
  return platform === "win32"
    ? {
        cmake: { owner: "Kitware", repository: "CMake", tag: "v3.31.6", asset: "cmake-3.31.6-windows-x86_64.zip", sha256: "d163cd3ab4959b0a53fa8988f2ddbd2e6c501658201e6a154386bad9dbe4f836" },
        ninja: { owner: "ninja-build", repository: "ninja", tag: "v1.12.1", asset: "ninja-win.zip", sha256: "f550fec705b6d6ff58f2db3c374c2277a37691678d6aba463adcbb129108467a" },
        clangd: { owner: "clangd", repository: "clangd", tag: "22.1.6", asset: "clangd-windows-22.1.6.zip", sha256: "ce54f16e0b4fd76d450eeda9664420b195360b73febcfe40e661108fa57f2ce1" },
      }
    : {
        cmake: { owner: "Kitware", repository: "CMake", tag: "v3.31.6", asset: "cmake-3.31.6-linux-x86_64.tar.gz", sha256: "5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf" },
        ninja: { owner: "ninja-build", repository: "ninja", tag: "v1.12.1", asset: "ninja-linux.zip", sha256: "6f98805688d19672bd699fbbfa2c2cf0fc054ac3df1f0e6a47664d963d530255" },
        clangd: { owner: "clangd", repository: "clangd", tag: "22.1.6", asset: "clangd-linux-22.1.6.zip", sha256: "a9c77443af2e447ed467e84771848d3a6ac1c56f84bcfcde717e66318de77cfa" },
      };
}

export function managedToolchainMarker(platform: "linux" | "win32"): string {
  const archives = managedToolchainArchives(platform);
  return `${(["clangd", "cmake", "ninja"] as const)
    .map((tool) => `${tool}:${archives[tool].asset}:${archives[tool].sha256}`)
    .join("\n")}\n`;
}

export function parseWindowsEnvironment(output: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

export function toolchainArchiveFormat(path: string): "tar" | "zip" {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower.endsWith(".zip") || lower.endsWith(".vsix")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar.xz")) return "tar";
  throw new Error(`Unsupported toolchain archive: ${path}`);
}
