export function matchesProjectMarker(marker: string, childNames: ReadonlySet<string>): boolean {
  const normalized = marker.toLocaleLowerCase("en-US");
  if (normalized.startsWith("*.") && normalized.indexOf("*", 1) === -1) {
    const suffix = normalized.slice(1);
    return [...childNames].some((name) => name.endsWith(suffix));
  }
  return childNames.has(normalized);
}
