export const INDEXING_SKILL_WARNING = "C++ background indexing is still in progress. This result may be incomplete, and an empty result is not authoritative.";

export function languageSkillUsable(status: string, hasWorker: boolean): boolean {
  return hasWorker && (status === "ready" || status === "indexing");
}

export function languageSkillStatusState(status: string): {
  indexReady: boolean;
  partial: boolean;
  status: string;
  warning?: string;
} {
  return {
    status,
    indexReady: status === "ready",
    partial: status === "indexing",
    ...(status === "indexing" ? { warning: INDEXING_SKILL_WARNING } : {}),
  };
}
