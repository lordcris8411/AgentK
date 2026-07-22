import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { SkillHubPreview, SkillHubScope } from "./types.js";
import { atomicWrite, isPathInside, piAgentDirectory, randomId } from "./utils.js";

const MAX_FILES = 80;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

type GitHubEntry = {
  type?: string;
  name?: string;
  path?: string;
  download_url?: string | null;
};

type GitHubRepository = { default_branch?: string };

type DownloadedFile = { path: string; bytes: Uint8Array };

type ParsedGitHubSource = {
  owner: string;
  repository: string;
  ref: string;
  directory: string;
};

function sourceError(message: string): Error {
  return new Error(`Skill Hub: ${message}`);
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized && normalized !== "." && normalized !== ".." ? normalized.slice(0, 80) : "skill";
}

function isSafeRelativePath(path: string): boolean {
  return !!path && !path.startsWith("/") && !path.split("/").some((part) => !part || part === "." || part === "..");
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Agent-K-Skill-Hub",
    },
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429)
      throw sourceError("GitHub API rate limit reached. Please try again later.");
    throw sourceError(`GitHub returned ${response.status} while reading this skill.`);
  }
  return response.json() as Promise<T>;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { "User-Agent": "Agent-K-Skill-Hub" } });
  if (!response.ok) throw sourceError(`Could not download a skill file (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

async function parseGitHubSource(sourceUrl: string): Promise<ParsedGitHubSource> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw sourceError("Paste a GitHub skill directory URL.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com")
    throw sourceError("Only HTTPS GitHub skill directory URLs are supported for now.");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) throw sourceError("The GitHub URL is missing its owner or repository.");
  const [owner, repository] = parts;
  if (!owner || !repository) throw sourceError("The GitHub URL is invalid.");
  if (parts.length === 2) {
    const info = await githubJson<GitHubRepository>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    );
    if (!info.default_branch) throw sourceError("GitHub did not provide this repository's default branch.");
    return { owner, repository, ref: info.default_branch, directory: "" };
  }
  if ((parts[2] !== "tree" && parts[2] !== "blob") || !parts[3])
    throw sourceError("Use a GitHub repository URL or a link to the directory containing SKILL.md.");
  const remainder = parts.slice(4);
  const directory = parts[2] === "blob" ? remainder.slice(0, -1).join("/") : remainder.join("/");
  if (directory && !isSafeRelativePath(directory)) throw sourceError("The skill directory path is invalid.");
  return { owner, repository, ref: parts[3], directory };
}

async function readDirectory(source: ParsedGitHubSource, path: string): Promise<GitHubEntry[]> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/contents/${encodedPath}?ref=${encodeURIComponent(source.ref)}`;
  const result = await githubJson<GitHubEntry[] | GitHubEntry>(endpoint);
  return Array.isArray(result) ? result : [result];
}

async function downloadSkillFiles(source: ParsedGitHubSource): Promise<DownloadedFile[]> {
  const files: DownloadedFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readDirectory(source, directory);
    for (const entry of entries) {
      if (entry.type === "dir" && entry.path && entry.name) {
        await visit(entry.path, `${relativeDirectory}${entry.name}/`);
        continue;
      }
      if (entry.type !== "file" || !entry.name || !entry.download_url) continue;
      const relativePath = `${relativeDirectory}${entry.name}`;
      if (!isSafeRelativePath(relativePath)) throw sourceError("The skill contains an unsafe file path.");
      if (files.length >= MAX_FILES) throw sourceError(`A skill may contain at most ${MAX_FILES} files.`);
      const bytes = await download(entry.download_url);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES)
        throw sourceError("A skill may be at most 2 MB before installation.");
      files.push({ path: relativePath, bytes });
    }
  };
  await visit(source.directory, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function hashFiles(files: DownloadedFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(file.bytes);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function frontmatterValue(markdown: string, key: string): string | undefined {
  const match = markdown.match(new RegExp(`^---\\s*$[\\s\\S]*?^${key}:\\s*["']?([^\\n"']+)["']?\\s*$`, "mi"));
  return match?.[1]?.trim();
}

async function load(sourceUrl: string): Promise<{ preview: SkillHubPreview; files: DownloadedFile[] }> {
  const source = await parseGitHubSource(sourceUrl);
  const files = await downloadSkillFiles(source);
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) throw sourceError("The selected directory does not contain a top-level SKILL.md file.");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(skill.bytes);
  const directoryName = safeSegment(basename(source.directory || source.repository));
  return {
    files,
    preview: {
      sourceUrl,
      source: `${source.owner}/${source.repository}@${source.ref}${source.directory ? `/${source.directory}` : ""}`,
      name: frontmatterValue(content, "name") ?? directoryName,
      description: frontmatterValue(content, "description"),
      directoryName,
      hash: hashFiles(files),
      skillMarkdown: content,
      files: files.map((file) => ({ path: file.path, bytes: file.bytes.byteLength })),
    },
  };
}

export async function previewSkillHub(sourceUrl: string): Promise<SkillHubPreview> {
  return (await load(sourceUrl)).preview;
}

export async function installSkillHub(
  sourceUrl: string,
  expectedHash: string,
  scope: SkillHubScope,
  cwd: string,
): Promise<void> {
  const { preview, files } = await load(sourceUrl);
  if (preview.hash !== expectedHash)
    throw sourceError("The source changed after preview. Review it again before installing.");
  const root = scope === "project" ? join(cwd, ".pi", "skills") : join(piAgentDirectory(), "skills");
  const destination = resolve(root, preview.directoryName);
  if (!isPathInside(root, destination)) throw sourceError("The install destination is invalid.");
  if (existsSync(destination)) throw sourceError(`A skill named "${preview.directoryName}" is already installed there.`);
  await mkdir(root, { recursive: true });
  const temporary = `${destination}.agent-k-${randomId()}.tmp`;
  await mkdir(temporary, { recursive: false });
  try {
    for (const file of files) {
      const target = resolve(temporary, file.path);
      if (!isPathInside(temporary, target)) throw sourceError("The skill contains an unsafe file path.");
      await atomicWrite(target, file.bytes);
    }
    await rename(temporary, destination);
  } catch (cause) {
    await rm(temporary, { force: true, recursive: true });
    throw cause;
  }
}
