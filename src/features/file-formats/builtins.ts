import type { FileFormatPlugin } from "./sdk";
import { matchesFileFormat } from "./sdk";

const textExtensions = [
  "py", "pyw", "js", "jsx", "ts", "tsx", "mjs", "cjs", "rs", "go", "java", "c", "cc", "cpp", "h", "hpp", "cs", "sh", "bash", "zsh", "ps1", "bat", "cmd", "css", "scss", "sass", "less", "vue", "svelte", "php", "rb", "swift", "kt", "kts", "dart", "lua", "r", "sql", "graphql", "gql", "mdx", "txt", "log", "json", "jsonc", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf", "env", "properties", "csv", "tsv",
] as const;

export const builtinFileFormats: readonly FileFormatPlugin[] = [
  {
    id: "agent-k.markdown",
    name: "Markdown",
    match: { extensions: ["md", "markdown", "mdown", "mkd"] },
    editor: "markdown",
    editable: true,
    monacoLanguage: "markdown",
  },
  {
    id: "agent-k.html",
    name: "HTML",
    match: { extensions: ["html", "htm"] },
    editor: "html",
    editable: true,
    monacoLanguage: "html",
  },
  {
    id: "agent-k.image",
    name: "Image preview",
    match: { extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"] },
    editor: "media",
    mediaKind: "image",
  },
  {
    id: "agent-k.audio",
    name: "Audio player",
    match: { extensions: ["mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "wma", "opus"] },
    editor: "media",
    mediaKind: "audio",
    capabilities: [
      { id: "play", label: "播放", description: "开始播放当前音频" },
      { id: "pause", label: "暂停", description: "暂停当前音频" },
      { id: "seek", label: "跳转", description: "按秒数前进或后退当前音频", parameters: { seconds: "number" } },
    ],
  },
  {
    id: "agent-k.video",
    name: "Video player",
    match: { extensions: ["mp4", "m4v", "mkv", "mov", "avi", "webm", "wmv", "flv", "mpeg", "mpg", "3gp", "ogv"] },
    editor: "media",
    mediaKind: "video",
    capabilities: [
      { id: "play", label: "播放", description: "开始播放当前视频" },
      { id: "pause", label: "暂停", description: "暂停当前视频" },
      { id: "seek", label: "跳转", description: "按秒数前进或后退当前视频", parameters: { seconds: "number" } },
    ],
  },
  {
    id: "agent-k.pdf",
    name: "PDF preview",
    match: { extensions: ["pdf"] },
    editor: "media",
    mediaKind: "pdf",
  },
  {
    id: "agent-k.text",
    name: "Text editor",
    match: {
      extensions: textExtensions,
      fileNames: ["dockerfile", "makefile", "license", "readme", ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".prettierrc", ".eslintrc"],
    },
    editor: "text",
    editable: true,
  },
];

export function resolveFileFormat(
  path: string,
  plugins: readonly FileFormatPlugin[] = [],
): FileFormatPlugin {
  return [...plugins, ...builtinFileFormats].find((plugin) => matchesFileFormat(plugin, path)) ?? {
    id: "agent-k.unsupported",
    name: "Unsupported file",
    match: {},
    editor: "unsupported",
  };
}

export function monacoLanguageFor(path: string): string {
  const matched = resolveFileFormat(path);
  if (matched.monacoLanguage) return matched.monacoLanguage;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ({
    py: "python", pyw: "python", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", yml: "yaml", yaml: "yaml", sh: "shell", ps1: "powershell", rs: "rust", css: "css", xml: "xml",
  } as Record<string, string>)[extension] ?? "plaintext";
}

export function mediaMimeTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", wma: "audio/x-ms-wma", opus: "audio/opus", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogv: "video/ogg", mpeg: "video/mpeg", mpg: "video/mpeg", "3gp": "video/3gpp", mkv: "video/x-matroska", avi: "video/x-msvideo", wmv: "video/x-msvideo", flv: "video/x-flv",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
