import type { FileFormatPlugin, FileMatchContext } from "./sdk";
import { fileFormatMatchRank } from "./sdk";

export function resolveFileFormat(
  context: FileMatchContext,
  plugins: readonly FileFormatPlugin[] = [],
  disabledIds: readonly string[] = [],
): FileFormatPlugin | undefined {
  const disabled = new Set(disabledIds);
  return plugins.reduce<{ plugin?: FileFormatPlugin; rank: number }>((best, plugin) => {
    if (disabled.has(plugin.id)) return best;
    const rank = fileFormatMatchRank(plugin, context);
    return rank > best.rank ? { plugin, rank } : best;
  }, { rank: 0 }).plugin;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  "3gp": "video/3gpp", aac: "audio/aac", avi: "video/x-msvideo",
  bat: "text/plain", bmp: "image/bmp", c: "text/x-c", cc: "text/x-c++", cmd: "text/plain", conf: "text/plain",
  cpp: "text/x-c++", cxx: "text/x-c++", css: "text/css", csv: "text/csv", flac: "audio/flac",
  gif: "image/gif", go: "text/x-go", h: "text/x-c", hh: "text/x-c++", hpp: "text/x-c++", hxx: "text/x-c++",
  htm: "text/html", html: "text/html", ico: "image/x-icon", java: "text/x-java-source",
  jpeg: "image/jpeg", jpg: "image/jpeg", js: "text/javascript", json: "application/json",
  jsonc: "application/json", jsx: "text/javascript", lock: "text/plain", log: "text/plain",
  m4a: "audio/mp4", m4v: "video/mp4", markdown: "text/markdown", md: "text/markdown",
  mkd: "text/markdown", mkv: "video/x-matroska", mov: "video/quicktime", mp3: "audio/mpeg",
  mp4: "video/mp4", mpeg: "video/mpeg", mpg: "video/mpeg", oga: "audio/ogg",
  ogg: "audio/ogg", ogv: "video/ogg", opus: "audio/opus", pdf: "application/pdf",
  lua: "text/x-lua", php: "text/x-php", png: "image/png", py: "text/x-python", pyw: "text/x-python",
  rb: "text/x-ruby", rs: "text/x-rust", sh: "text/x-shellscript", svg: "image/svg+xml",
  toml: "application/toml", ts: "text/typescript", tsv: "text/tab-separated-values",
  tsx: "text/typescript", txt: "text/plain", wav: "audio/wav", webm: "video/webm",
  webp: "image/webp", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml",
};

export function mimeTypeForPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

export function fileMatchContext(
  path: string,
  absolutePath: string,
): FileMatchContext {
  return { absolutePath, mimeType: mimeTypeForPath(path), path };
}

export function languageIdFor(path: string, disabledIds: readonly string[] = []): string {
  void disabledIds;
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if ([".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile"].includes(name))
    return "shell";
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return ({
    c: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", h: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
    cs: "csharp", go: "go", java: "java", lua: "lua", php: "php", py: "python", pyw: "python",
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", sh: "shell", bash: "shell", zsh: "shell",
    bat: "bat", cmd: "bat",
    ps1: "powershell", rs: "rust", css: "css", scss: "scss", less: "less", xml: "xml",
    rb: "ruby", swift: "swift", kt: "kotlin", kts: "kotlin", dart: "dart", r: "r", sql: "sql",
    graphql: "graphql", gql: "graphql", mdx: "mdx", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  } as Record<string, string>)[extension] ?? "plaintext";
}
