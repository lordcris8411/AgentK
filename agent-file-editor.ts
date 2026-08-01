import { statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export const FILE_EDITOR_OPEN_REQUEST_PREFIX = "agent-k-file-open:";

export function validatedFileToOpen(cwd: string, requestedPath: string): string {
  if (!requestedPath.trim())
    throw new Error("A workspace file path is required to open a file.");
  const workspace = normalize(cwd);
  const target = normalize(
    isAbsolute(requestedPath) ? requestedPath : join(workspace, requestedPath),
  );
  const workspaceRelative = relative(workspace, target);
  if (
    workspaceRelative === ".." ||
    workspaceRelative.startsWith(`..${sep}`) ||
    isAbsolute(workspaceRelative)
  )
    throw new Error(`File is outside the current workspace: ${requestedPath}`);
  let file;
  try {
    file = statSync(target);
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code ?? "")
      : "";
    if (code === "ENOENT") throw new Error(`File does not exist: ${requestedPath}`);
    throw cause;
  }
  if (!file.isFile()) throw new Error(`Path is not a file: ${requestedPath}`);
  return target;
}

export async function requestFileOpen(
  cwd: string,
  requestedPath: string,
  payload: Record<string, unknown>,
  input: (request: string) => Promise<string | undefined>,
): Promise<void> {
  validatedFileToOpen(cwd, requestedPath);
  const response = await input(
    `${FILE_EDITOR_OPEN_REQUEST_PREFIX}${JSON.stringify(payload)}`,
  );
  if (!response)
    throw new Error("Agent K file editor did not acknowledge the open request.");
  let result: { error?: unknown; ok?: unknown };
  try {
    result = JSON.parse(response) as { error?: unknown; ok?: unknown };
  } catch {
    throw new Error(`Invalid Agent K file editor response: ${response}`);
  }
  if (result.ok !== true)
    throw new Error(
      typeof result.error === "string" && result.error
        ? result.error
        : `Unable to open file: ${requestedPath}`,
    );
}
