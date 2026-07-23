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
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        }) ||
        left.cwd.localeCompare(right.cwd, undefined, {
          sensitivity: "base",
        }),
    );
}
