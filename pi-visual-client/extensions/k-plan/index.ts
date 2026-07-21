/**
 * K's Plan
 *
 * A standard Pi extension for creating, validating, reviewing, and executing
 * file-backed plans. It intentionally uses only Pi's public Extension API so
 * the same package works in Pi's TUI and in RPC hosts such as Agent K.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const STATE_TYPE = "agent-k-plan";
const CONTEXT_TYPE = "agent-k-plan-context";
const MAX_MODEL_REPAIRS = 2;

type PlanState = {
  planFilePath: string | null;
  isPlanMode: boolean;
  repairAttempts: number;
};

export type PlanStep = { step: number; text: string };
export type PlanValidation = {
  valid: boolean;
  title: string | null;
  goal: string;
  steps: PlanStep[];
  notes: string;
  errors: string[];
};

function section(content: string, name: string): string {
  const match = new RegExp(`^##\\s+${name}\\s*$`, "m").exec(content);
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const next = /^##\s+/m.exec(rest);
  return rest.slice(0, next?.index ?? rest.length).trim();
}

export function validatePlanMarkdown(content: string): PlanValidation {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  const titleMatch = /^# Plan:\s*(.+)$/m.exec(normalized);
  const titleIndex = normalized.search(/^# Plan:/m);
  const goalIndex = normalized.search(/^## Goal\s*$/m);
  const stepsIndex = normalized.search(/^## Steps\s*$/m);
  const notesIndex = normalized.search(/^## Notes\s*$/m);
  const goal = section(normalized, "Goal");
  const stepsBody = section(normalized, "Steps");
  const notes = section(normalized, "Notes");
  const steps: PlanStep[] = [];
  for (const match of stepsBody.matchAll(/^\s*(\d+)\.\s+(.+)$/gm)) {
    steps.push({ step: Number.parseInt(match[1], 10), text: match[2].trim() });
  }

  const errors: string[] = [];
  const structuralHeadings = normalized
    .split("\n")
    .filter((line) => /^#{1,2}\s+/.test(line));
  const requiredHeadings = [
    titleMatch?.[0] ?? "",
    "## Goal",
    "## Steps",
    "## Notes",
  ];
  if (!titleMatch?.[1]?.trim()) errors.push("missing '# Plan: <title>'");
  if (!goal) errors.push("missing non-empty '## Goal' section");
  if (steps.length === 0) errors.push("missing numbered steps under '## Steps'");
  if (!notes) errors.push("missing non-empty '## Notes' section");
  if (!(titleIndex === 0 && titleIndex < goalIndex && goalIndex < stepsIndex && stepsIndex < notesIndex)) {
    errors.push("sections are missing or not in the required order");
  }
  if (
    structuralHeadings.length !== requiredHeadings.length ||
    structuralHeadings.some((heading, index) =>
      index === 0 ? !/^# Plan:\s*.+$/.test(heading) : heading !== requiredHeadings[index],
    )
  ) {
    errors.push("plan must contain exactly the four required structural headings");
  }
  if (steps.some((item, index) => item.step !== index + 1)) {
    errors.push("steps are not sequentially numbered from 1");
  }
  const nonStepContent = stepsBody
    .split("\n")
    .filter((line) => line.trim() && !/^\s*\d+\.\s+.+$/.test(line))
    .filter((line) => /^\s*(?:#{1,6}\s+|\d+[.)、．]\s*)/.test(line));
  if (nonStepContent.length > 0) errors.push("step headings do not use the canonical numbered-list format");

  return {
    valid: errors.length === 0,
    title: titleMatch?.[1]?.trim() ?? null,
    goal,
    steps,
    notes,
    errors,
  };
}

function canonicalHeading(line: string): string {
  if (/^#{1,2}\s*(?:Plan|计划)\s*[：:]\s*/i.test(line)) {
    return line.replace(/^#{1,2}\s*(?:Plan|计划)\s*[：:]\s*/i, "# Plan: ");
  }
  if (/^#{1,6}\s*(?:Goal|目标)\s*$/i.test(line)) return "## Goal";
  if (/^#{1,6}\s*(?:Steps|步骤|实施步骤|开发步骤|计划步骤)\s*$/i.test(line)) return "## Steps";
  if (/^#{1,6}\s*(?:Notes|备注|说明|注意事项)\s*$/i.test(line)) return "## Notes";
  return line;
}

/** Repair common model formatting drift without changing plan substance. */
export function repairPlanMarkdown(content: string): string {
  const lines = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(canonicalHeading);
  let inSteps = false;
  let stepNumber = 0;
  const repaired = lines.map((line) => {
    if (/^## Steps\s*$/.test(line)) {
      inSteps = true;
      stepNumber = 0;
      return "## Steps";
    }
    if (/^##\s+/.test(line)) inSteps = false;
    if (!inSteps) return line;
    const match = /^\s*(?:#{3,6}\s*)?(\d+)[.)、．]\s*(.+?)\s*$/.exec(line);
    if (!match) return line;
    stepNumber += 1;
    return `${stepNumber}. ${match[2].trim()}`;
  });
  return `${repaired.join("\n").trim()}\n`;
}

function deriveSessionId(sessionFile: string | null | undefined): string {
  if (!sessionFile) {
    return createHash("sha256")
      .update(`${Date.now()}-${Math.random()}`)
      .digest("hex")
      .slice(0, 16);
  }
  const value = basename(sessionFile).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return value || createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
}

function executionPrompt(content: string): string {
  return `Execute the following plan step by step. After completing each step, state which step you completed.\n\n${content}`;
}

export default function kPlan(pi: ExtensionAPI): void {
  let state: PlanState = { planFilePath: null, isPlanMode: false, repairAttempts: 0 };
  let commandContext: ExtensionCommandContext | null = null;
  let reviewOpen = false;

  const persist = () => pi.appendEntry(STATE_TYPE, state);
  const updateStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(
      STATE_TYPE,
      state.isPlanMode ? ctx.ui.theme.fg("warning", "K's Plan: planning") : undefined,
    );
  };
  const leavePlanMode = (ctx: ExtensionContext) => {
    state = { ...state, isPlanMode: false, repairAttempts: 0 };
    updateStatus(ctx);
    persist();
  };

  async function readValidatedPlan(ctx: ExtensionContext): Promise<{ content: string; validation: PlanValidation } | null> {
    if (!state.planFilePath) return null;
    let content: string;
    try {
      content = await readFile(state.planFilePath, "utf8");
    } catch {
      ctx.ui.notify("K's Plan could not read the plan file.", "error");
      return null;
    }
    const repaired = repairPlanMarkdown(content);
    if (repaired !== content) {
      await writeFile(state.planFilePath, repaired, "utf8");
      content = repaired;
    }
    return { content, validation: validatePlanMarkdown(content) };
  }

  async function requestModelRepair(ctx: ExtensionContext, validation: PlanValidation): Promise<void> {
    if (!state.planFilePath) return;
    if (state.repairAttempts >= MAX_MODEL_REPAIRS) {
      ctx.ui.notify(`K's Plan could not repair the plan format: ${validation.errors.join("; ")}`, "error");
      return;
    }
    state = { ...state, repairAttempts: state.repairAttempts + 1 };
    persist();
    pi.sendUserMessage(
      `The plan at ${state.planFilePath} does not strictly match K's Plan format. Problems: ${validation.errors.join("; ")}.\n\n` +
        "Rewrite that file now while preserving its substance. It must contain exactly these sections in this order:\n\n" +
        "# Plan: <non-empty title>\n\n## Goal\n<non-empty goal>\n\n## Steps\n1. <step>\n2. <step>\n\n## Notes\n<non-empty notes>\n\n" +
        "Steps must be a sequential Markdown numbered list starting at 1. Do not use headings for individual steps.",
      { deliverAs: "followUp" },
    );
    ctx.ui.notify("K's Plan is correcting the plan format…", "warning");
  }

  async function executePlan(ctx: ExtensionContext, content: string, title: string | null): Promise<void> {
    leavePlanMode(ctx);
    if (!commandContext) {
      if (title) pi.setSessionName(`Plan: ${title}`);
      pi.sendUserMessage(executionPrompt(content), { deliverAs: "followUp" });
      return;
    }
    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await commandContext.newSession({
      parentSession,
      setup: async (sessionManager) => {
        if (title) sessionManager.appendSessionInfo(`Plan: ${title}`);
      },
      withSession: async (replacementCtx) => {
        await replacementCtx.sendUserMessage(executionPrompt(content), { deliverAs: "followUp" });
      },
    });
    if (result.cancelled) ctx.ui.notify("K's Plan execution was cancelled.", "warning");
  }

  async function review(ctx: ExtensionContext): Promise<void> {
    if (reviewOpen) return;
    reviewOpen = true;
    try {
      while (state.isPlanMode) {
        const result = await readValidatedPlan(ctx);
        if (!result) return;
        if (!result.validation.valid) {
          await requestModelRepair(ctx, result.validation);
          return;
        }
        state = { ...state, repairAttempts: 0 };
        persist();
        const choice = await ctx.ui.select(
          `K's Plan (${result.validation.steps.length} steps) — What would you like to do?`,
          [
            "Ready — Execute the plan",
            "Edit — Ask for changes",
            "Open in editor — Edit manually",
            "Cancel — Discard the plan",
          ],
        );
        if (!choice || choice.startsWith("Cancel")) {
          leavePlanMode(ctx);
          ctx.ui.notify("K's Plan cancelled.", "info");
          return;
        }
        if (choice.startsWith("Ready")) {
          await executePlan(ctx, result.content, result.validation.title);
          return;
        }
        if (choice.startsWith("Edit —")) {
          const changes = await ctx.ui.editor("What changes should K's Plan make?", "");
          if (changes?.trim()) {
            pi.sendUserMessage(
              `Update the plan at ${state.planFilePath} with these changes:\n\n${changes.trim()}\n\nKeep K's Plan's strict format.`,
              { deliverAs: "followUp" },
            );
            return;
          }
          continue;
        }
        if (choice.startsWith("Open in editor")) {
          const edited = await ctx.ui.editor("Edit K's Plan", result.content);
          if (edited !== undefined) await writeFile(state.planFilePath!, edited, "utf8");
        }
      }
    } finally {
      reviewOpen = false;
    }
  }

  pi.registerCommand("plan", {
    description: "Create, validate, review, and execute a K's Plan",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /plan <description of what to build>", "warning");
        return;
      }
      commandContext = ctx;
      const sessionId = deriveSessionId(ctx.sessionManager.getSessionFile());
      const planDirectory = join(homedir(), ".pi", "agent", "plans", sessionId);
      await mkdir(planDirectory, { recursive: true });
      state = {
        planFilePath: join(planDirectory, "plan.md"),
        isPlanMode: true,
        repairAttempts: 0,
      };
      updateStatus(ctx);
      persist();
      pi.sendUserMessage(
        `Analyze the codebase and create a detailed plan for: ${args.trim()}\n\n` +
          `Write the plan to: ${state.planFilePath}\n\n` +
          "Use this exact format:\n\n# Plan: <title>\n\n## Goal\n<brief non-empty goal>\n\n" +
          "## Steps\n1. Step one description\n2. Step two description\n3. Step three description\n\n" +
          "## Notes\n<non-empty context, constraints, or decisions>\n\n" +
          "Use a plain numbered list for steps, starting at 1. Do not format steps as headings. Be specific and actionable.",
        { deliverAs: "followUp" },
      );
    },
  });

  pi.on("before_agent_start", async () => {
    if (!state.isPlanMode) return;
    return {
      message: {
        customType: CONTEXT_TYPE,
        content: `[K'S PLAN MODE ACTIVE]\nExplore and understand the codebase, but do not modify project files. The only file you may create or update is ${state.planFilePath}. Before finishing, verify that file strictly follows K's Plan format and repair it if necessary.`,
        display: false,
      },
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.isPlanMode || !state.planFilePath || !ctx.hasUI) return;
    try {
      await access(state.planFilePath);
    } catch {
      return;
    }
    await review(ctx);
  });

  pi.on("context", async (event) => {
    if (state.isPlanMode) return;
    return {
      messages: event.messages.filter(
        (message) => (message as typeof message & { customType?: string }).customType !== CONTEXT_TYPE,
      ),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const lastState = ctx.sessionManager
      .getEntries()
      .filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === STATE_TYPE)
      .pop() as { data?: Partial<PlanState> } | undefined;
    state = {
      planFilePath: lastState?.data?.planFilePath ?? null,
      isPlanMode: lastState?.data?.isPlanMode ?? false,
      repairAttempts: lastState?.data?.repairAttempts ?? 0,
    };
    updateStatus(ctx);
  });
}
