import type { ProjectSummary } from "../../lib/desktop";

export function sortProjectsByActivity(
  projects: readonly ProjectSummary[],
): ProjectSummary[] {
  return projects
    .map((project) => ({
      ...project,
      sessions: [...project.sessions].sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          left.path.localeCompare(right.path),
      ),
    }))
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      const alphabetical = left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
      }) || left.cwd.localeCompare(right.cwd, undefined, {
        sensitivity: "base",
      });
      return left.pinned ? alphabetical : right.updatedAt - left.updatedAt || alphabetical;
    });
}
