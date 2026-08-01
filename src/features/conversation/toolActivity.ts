export type ToolActivityCall = {
  args: Record<string, unknown>;
  name: string;
};

export function toolActivityContent(
  item: { content?: string; tool?: string },
  matchingCall: ToolActivityCall | undefined,
  english: boolean,
): string {
  const command = item.tool === "bash" && matchingCall && typeof matchingCall.args.command === "string"
    ? matchingCall.args.command.trim()
    : "";
  if (command) {
    const output = item.content || (english ? "Waiting for tool result…" : "等待工具结果…");
    return `$ ${command}\n\n${output}`;
  }
  return item.content || (matchingCall
    ? JSON.stringify(matchingCall.args, null, 2)
    : (english ? "Waiting for tool result…" : "等待工具结果…"));
}
