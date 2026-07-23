import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSkillHubInput } from "../.electron-dist/skill-hub.js";

test("normalizes a skills.sh npx command with an inline skill name", () => {
  assert.deepEqual(
    normalizeSkillHubInput("$ npx skills add vercel-labs/agent-skills@web-design-guidelines"),
    {
      skillName: "web-design-guidelines",
      sourceUrl: "https://github.com/vercel-labs/agent-skills",
    },
  );
});

test("normalizes skills CLI options without executing the command", () => {
  assert.deepEqual(
    normalizeSkillHubInput(
      "npx --yes skills@latest add vercel-labs/agent-skills --skill 'frontend-design' -g -y",
    ),
    {
      skillName: "frontend-design",
      sourceUrl: "https://github.com/vercel-labs/agent-skills",
    },
  );
});

test("normalizes a skills.sh catalog URL", () => {
  assert.deepEqual(
    normalizeSkillHubInput("https://skills.sh/vercel-labs/agent-skills/react-best-practices"),
    {
      skillName: "react-best-practices",
      sourceUrl: "https://github.com/vercel-labs/agent-skills",
    },
  );
});

test("preserves a direct GitHub skill directory URL", () => {
  const sourceUrl = "https://github.com/vercel-labs/skills/tree/main/skills/find-skills";
  assert.deepEqual(normalizeSkillHubInput(sourceUrl), { sourceUrl });
});
