export function directoryAppWorkspacePath(directoryPath: string, requestedPath: string): string {
  const requested = requestedPath.trim().replaceAll("\\", "/");
  if (/^(?:[a-z]:\/|\/)/i.test(requested))
    throw new Error("Directory app paths must be relative");
  const parts = requested.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === ".."))
    throw new Error("Directory app paths cannot leave the selected directory");
  const base = directoryPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return [...(base ? [base] : []), ...parts].join("/");
}
