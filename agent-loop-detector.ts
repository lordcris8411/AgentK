import { createHash } from "node:crypto";

const TOOL_CALL_LOOP_THRESHOLD = 5;
const MAX_TOOL_CALL_CYCLE_LENGTH = 5;
const CONTENT_LOOP_THRESHOLD = 10;
const CONTENT_CHUNK_SIZE = 50;
const MAX_CONTENT_HISTORY_LENGTH = 5_000;

export type AgentLoopDetection = {
  type: "tool-call-cycle" | "content-repetition";
  detail: string;
};

type LoopDetectorOptions = {
  contentChunkSize?: number;
  contentHistoryLength?: number;
  contentRepeatThreshold?: number;
  maxToolCallCycleLength?: number;
  toolCallRepeatThreshold?: number;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().flatMap((key) => object[key] === undefined
    ? []
    : [`${JSON.stringify(key)}:${stableJson(object[key])}`]).join(",")}}`;
}

/**
 * Deterministic, zero-model-cost loop detection inspired by Gemini CLI's two
 * local checks: short tool-call cycles and repeated streaming-content chunks.
 */
export class AgentLoopDetector {
  private readonly contentChunkSize: number;
  private readonly contentHistoryLength: number;
  private readonly contentRepeatThreshold: number;
  private readonly maxToolCallCycleLength: number;
  private readonly toolCallRepeatThreshold: number;
  private toolCallHistory: string[] = [];
  private streamContentHistory = "";
  private contentStats = new Map<string, number[]>();
  private lastContentIndex = 0;
  private inCodeBlock = false;
  private detection?: AgentLoopDetection;

  constructor(options: LoopDetectorOptions = {}) {
    this.contentChunkSize = options.contentChunkSize ?? CONTENT_CHUNK_SIZE;
    this.contentHistoryLength = options.contentHistoryLength ?? MAX_CONTENT_HISTORY_LENGTH;
    this.contentRepeatThreshold = options.contentRepeatThreshold ?? CONTENT_LOOP_THRESHOLD;
    this.maxToolCallCycleLength = options.maxToolCallCycleLength ?? MAX_TOOL_CALL_CYCLE_LENGTH;
    this.toolCallRepeatThreshold = options.toolCallRepeatThreshold ?? TOOL_CALL_LOOP_THRESHOLD;
  }

  reset(): void {
    this.toolCallHistory = [];
    this.resetContentTracking(true);
    this.detection = undefined;
  }

  resetStreamingContent(): void {
    this.resetContentTracking(true);
  }

  addToolCall(name: string, args: Record<string, unknown>): AgentLoopDetection | undefined {
    if (this.detection) return this.detection;
    this.resetContentTracking(true);
    const key = createHash("sha256").update(`${name}:${stableJson(args)}`).digest("hex");
    this.toolCallHistory.push(key);
    const maxHistory = this.maxToolCallCycleLength * this.toolCallRepeatThreshold;
    if (this.toolCallHistory.length > maxHistory) this.toolCallHistory = this.toolCallHistory.slice(-maxHistory);

    const count = this.toolCallHistory.length;
    for (let cycleLength = 1; cycleLength <= this.maxToolCallCycleLength; cycleLength++) {
      const requiredLength = cycleLength * this.toolCallRepeatThreshold;
      if (count < requiredLength) continue;
      const cycle = this.toolCallHistory.slice(-cycleLength);
      let matches = true;
      for (let index = 0; index < requiredLength; index++) {
        if (this.toolCallHistory[count - requiredLength + index] !== cycle[index % cycleLength]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        const argsPreview = stableJson(args).slice(0, 300);
        this.detection = {
          type: "tool-call-cycle",
          detail: `Repeated tool-call cycle (length ${cycleLength}): ${name} ${argsPreview}`,
        };
        return this.detection;
      }
    }
    return undefined;
  }

  addContent(content: string): AgentLoopDetection | undefined {
    if (this.detection) return this.detection;
    if (!content) return undefined;

    const numFences = content.match(/```/g)?.length ?? 0;
    const hasTable = /(^|\n)\s*(\|.*\||[|+-]{3,})/.test(content);
    const hasListItem = /(^|\n)\s*[*-+]\s/.test(content) || /(^|\n)\s*\d+\.\s/.test(content);
    const hasHeading = /(^|\n)#+\s/.test(content);
    const hasBlockquote = /(^|\n)>\s/.test(content);
    const isDivider = /^[+\-_=*\u2500-\u257f]+$/.test(content);
    if (numFences || hasTable || hasListItem || hasHeading || hasBlockquote || isDivider) {
      this.resetContentTracking(false);
    }

    const wasInCodeBlock = this.inCodeBlock;
    if (numFences % 2 === 1) this.inCodeBlock = !this.inCodeBlock;
    if (wasInCodeBlock || this.inCodeBlock || isDivider) return undefined;

    this.streamContentHistory += content;
    this.truncateContentHistory();
    while (this.lastContentIndex + this.contentChunkSize <= this.streamContentHistory.length) {
      const chunk = this.streamContentHistory.substring(
        this.lastContentIndex,
        this.lastContentIndex + this.contentChunkSize,
      );
      const hash = createHash("sha256").update(chunk).digest("hex");
      if (this.isRepeatingChunk(chunk, hash)) {
        const sample = this.streamContentHistory.substring(
          Math.max(0, this.lastContentIndex - 20),
          this.lastContentIndex + this.contentChunkSize,
        ).trim();
        this.detection = {
          type: "content-repetition",
          detail: `Repeating streamed content: ${JSON.stringify(sample.slice(0, 160))}`,
        };
        return this.detection;
      }
      this.lastContentIndex++;
    }
    return undefined;
  }

  private isRepeatingChunk(chunk: string, hash: string): boolean {
    const existing = this.contentStats.get(hash);
    if (!existing) {
      this.contentStats.set(hash, [this.lastContentIndex]);
      return false;
    }
    const original = this.streamContentHistory.substring(existing[0], existing[0] + this.contentChunkSize);
    if (original !== chunk) return false;
    existing.push(this.lastContentIndex);
    if (existing.length < this.contentRepeatThreshold) return false;

    const recent = existing.slice(-this.contentRepeatThreshold);
    const averageDistance = (recent[recent.length - 1] - recent[0]) / (this.contentRepeatThreshold - 1);
    if (averageDistance > this.contentChunkSize * 5) return false;
    const periods = new Set<string>();
    for (let index = 0; index < recent.length - 1; index++) {
      periods.add(this.streamContentHistory.substring(recent[index], recent[index + 1]));
    }
    return periods.size <= Math.floor(this.contentRepeatThreshold / 2);
  }

  private truncateContentHistory(): void {
    if (this.streamContentHistory.length <= this.contentHistoryLength) return;
    const removed = this.streamContentHistory.length - this.contentHistoryLength;
    this.streamContentHistory = this.streamContentHistory.slice(removed);
    this.lastContentIndex = Math.max(0, this.lastContentIndex - removed);
    for (const [hash, indices] of this.contentStats) {
      const adjusted = indices.map((index) => index - removed).filter((index) => index >= 0);
      if (adjusted.length) this.contentStats.set(hash, adjusted);
      else this.contentStats.delete(hash);
    }
  }

  private resetContentTracking(resetCodeBlock: boolean): void {
    this.streamContentHistory = "";
    this.contentStats.clear();
    this.lastContentIndex = 0;
    if (resetCodeBlock) this.inCodeBlock = false;
  }
}
