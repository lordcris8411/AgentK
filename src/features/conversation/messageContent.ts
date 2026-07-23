const fileFormatContextPattern =
  /\s*<agent_k_file_format>[\s\S]*?<\/agent_k_file_format>\s*$/u;
const attachedFilesContextPattern =
  /\s*<attached_files>[\s\S]*?<\/attached_files>(?:\s*Use the available file tools to inspect these local files when needed\.)?\s*$/u;
const leadingSkillPattern = /^\s*<skill\b([^>]*)>[\s\S]*?<\/skill>\s*/u;

function skillName(attributes: string): string | undefined {
  return /\bname\s*=\s*"([^"]+)"/u.exec(attributes)?.[1]
    ?? /\bname\s*=\s*'([^']+)'/u.exec(attributes)?.[1];
}

function withoutAgentKContext(content: string): string {
  let visible = content;
  let previous: string;
  do {
    previous = visible;
    visible = visible
      .replace(fileFormatContextPattern, "")
      .replace(attachedFilesContextPattern, "");
  } while (visible !== previous);
  return visible.trim();
}

export function displayUserContent(role: unknown, content: string): string {
  if (role !== "user") return content;

  let visible = withoutAgentKContext(content);
  const expandedSkills: string[] = [];
  let expandedSkill = leadingSkillPattern.exec(visible);
  while (expandedSkill) {
    const name = skillName(expandedSkill[1] ?? "");
    if (name) expandedSkills.push(name);
    visible = visible.slice(expandedSkill[0].length).trim();
    expandedSkill = leadingSkillPattern.exec(visible);
  }

  const plan = /^Analyze the codebase and create a detailed plan for: ([\s\S]+?)\n\nWrite the plan to: [\s\S]+?\n\nUse this format:/u.exec(
    visible,
  );
  if (plan) return `/plan ${plan[1].trim()}`;
  if (visible) return visible;
  return expandedSkills.map((name) => `/skill:${name}`).join(" ");
}
