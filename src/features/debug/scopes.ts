import type { DebugScope } from "./types";

/** Scopes suitable for the Locals pane; static/global/register data has its own semantics. */
export function isLocalDebugScope(scope: Pick<DebugScope, "name" | "presentationHint">): boolean {
  const hint = scope.presentationHint?.trim().toLocaleLowerCase("en-US");
  if (hint === "registers") return false;
  if (hint === "arguments" || hint === "locals") return true;
  const name = scope.name.trim().toLocaleLowerCase("en-US");
  return !/(?:^|\s)(?:global|globals|register|registers|static|statics)(?:\s|$)/u.test(name);
}
