export type WorkspaceWatchKind = "change" | "rename";

/** A create/delete/rename must survive a following content-change event in the
 * same debounce window, otherwise the renderer never refreshes its file tree. */
export function mergeWorkspaceWatchKind(
  previous: WorkspaceWatchKind | undefined,
  next: WorkspaceWatchKind,
): WorkspaceWatchKind {
  return previous === "rename" || next === "rename" ? "rename" : "change";
}
