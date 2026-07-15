import { z } from "zod";
import { generateText, type LanguageModel, type ModelMessage } from "ai";

export const compactionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  keepRecent: z.number().int().positive().default(4000),
  reserveTokens: z.number().int().nonnegative().default(2000),
  contextWindow: z.number().int().nonnegative().default(0),
  midTurnCompactThreshold: z.number().min(0).max(1).default(0),
  compactionPrompt: z.string().optional(),
  summaryRole: z.enum(["system", "assistant"]).default("assistant"),
  summaryPrefix: z.string().default("[Recap of my prior work in this conversation]"),
});

export type CompactionConfig = z.infer<typeof compactionConfigSchema>;

export interface CompactionRecord {
  summary: string;
  firstKeptIndex: number;
  summarizedCount: number;
  tokensSaved: number;
  createdAt: string;
}

export interface CompactionResult {
  summary: string;
  tokensSaved: number;
  summarizedCount: number;
  firstKeptIndex: number;
}

const TOKENS_PER_CHAR = 0.25;
const ROLE_OVERHEAD = 4;

const DEFAULT_COMPACTION_PROMPT = `You are a conversation summarizer. Your task is to compress an agent-user conversation into a concise summary that preserves all essential context.

Below is the conversation to summarize:
<conversation>
{conversation}
</conversation>

{previous_summary}

{instructions}

Produce a summary that captures:
- The user's original request(s) and goals
- Key decisions made and actions taken by the agent
- Important findings, outputs, and results
- Errors encountered and how they were resolved
- Any unfinished tasks or pending follow-ups
- Relevant constraints, preferences, or context the user provided

Write the summary in a way that allows the agent to continue working without losing context. Be specific and factual — include names, paths, values, and details.`;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

export function estimateMessageTokens(msg: ModelMessage): number {
  const content = typeof msg.content === "string" ? msg.content : stringifyContent(msg.content);
  return ROLE_OVERHEAD + estimateTokens(content);
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return (part as { text: string }).text;
        if (part && typeof part === "object" && "type" in part) return JSON.stringify(part);
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return "";
}

export function selectCompactionCut(
  messages: ModelMessage[],
  keepRecent: number,
): number {
  if (messages.length === 0) return 0;

  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i]);
    if (accumulated >= keepRecent) {
      const keepCount = messages.length - i;
      return messages.length - keepCount;
    }
  }
  return 0;
}

export function needsCompaction(
  totalTokens: number,
  contextWindow: number,
  reserveTokens: number,
): boolean {
  if (contextWindow === 0) return false;
  return totalTokens > contextWindow - reserveTokens;
}

export function serializeConversation(messages: ModelMessage[]): string {
  return messages
    .map((msg) => {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      const content =
        typeof msg.content === "string" ? msg.content : stringifyContent(msg.content);
      return `[${role}]: ${content}`;
    })
    .join("\n\n");
}

export function buildCompactionPrompt(
  conversation: string,
  previousSummary: string | null,
  customInstructions?: string,
): string {
  const instructions = customInstructions ?? "Keep the summary concise but thorough.";
  const prevSection = previousSummary
    ? `Previous summary (for iterative context — build on this):\n${previousSummary}`
    : "No previous summary.";

  return DEFAULT_COMPACTION_PROMPT
    .replace("{conversation}", conversation)
    .replace("{previous_summary}", prevSection)
    .replace("{instructions}", instructions);
}

export async function compactMessages({
  model,
  messages,
  config,
  previousSummary,
}: {
  model: LanguageModel;
  messages: ModelMessage[];
  config?: CompactionConfig;
  previousSummary?: string | null;
}): Promise<CompactionResult> {
  const cfg = compactionConfigSchema.parse(config ?? {});

  if (!cfg.enabled) {
    return {
      summary: "",
      tokensSaved: 0,
      summarizedCount: 0,
      firstKeptIndex: 0,
    };
  }

  if (messages.length === 0) {
    return {
      summary: "",
      tokensSaved: 0,
      summarizedCount: 0,
      firstKeptIndex: 0,
    };
  }

  const cut = selectCompactionCut(messages, cfg.keepRecent);
  if (cut === 0) {
    return {
      summary: "",
      tokensSaved: 0,
      summarizedCount: 0,
      firstKeptIndex: 0,
    };
  }

  const toSummarize = messages.slice(0, cut);
  const conversation = serializeConversation(toSummarize);
  const prompt = buildCompactionPrompt(
    conversation,
    previousSummary ?? null,
    cfg.compactionPrompt,
  );

  const beforeTokens = toSummarize.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  const result = await generateText({
    model,
    prompt,
    temperature: 0,
    maxOutputTokens: Math.max(cfg.keepRecent, 1000),
    toolChoice: "none",
  });

  const summary = result.text.trim();
  const summaryTokens = estimateTokens(summary);
  const tokensSaved = Math.max(0, beforeTokens - summaryTokens);

  return {
    summary,
    tokensSaved,
    summarizedCount: cut,
    firstKeptIndex: cut,
  };
}

export function applyCompaction(
  messages: ModelMessage[],
  result: CompactionResult,
  config?: CompactionConfig,
): ModelMessage[] {
  if (result.summarizedCount === 0) return messages;

  const cfg = compactionConfigSchema.parse(config ?? {});
  const prefix = cfg.summaryPrefix;
  const content = prefix ? `${prefix}\n\n${result.summary}` : result.summary;

  let summaryMsg: ModelMessage;
  if (cfg.summaryRole === "system") {
    summaryMsg = { role: "system", content } as ModelMessage;
  } else {
    summaryMsg = { role: "assistant", content } as ModelMessage;
  }

  return [summaryMsg, ...messages.slice(result.firstKeptIndex)];
}

export type { ModelMessage };
