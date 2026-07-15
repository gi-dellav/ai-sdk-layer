import { generateText, type LanguageModel, type ModelMessage, type Tool } from "ai";
import { z } from "zod";
import type { AdvisorConfig } from "./types.js";
import { advisorConfigSchema } from "./types.js";
import { formatConversation } from "./format-conversation.js";

const DEFAULT_SYSTEM_PROMPT = `You are a strategic advisor for a coding assistant. You receive a conversation transcript and the assistant's question. Provide concise, actionable, step-by-step guidance. Focus on unblocking the assistant — identify root causes, suggest concrete fixes, and note risks. Do not repeat the transcript back. Be direct.`;

export interface AdvisorToolInstance {
  tool: Tool;
  readonly usageCount: number;
  resetUsage(): void;
}

export function createAdvisor(
  model: LanguageModel,
  config?: AdvisorConfig,
): AdvisorToolInstance {
  if (!model) {
    throw new Error("advisor requires a LanguageModel");
  }

  const cfg = advisorConfigSchema.parse(config ?? {});
  const systemPrompt = cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxUses = cfg.maxUses;
  const contextLimit = cfg.contextLimit;

  let usageCount = 0;

  const advisorTool: Tool = {
    description:
      cfg.description ??
      "Consult a strategic advisor model for guidance when you are stuck, need a second opinion, or face a complex architectural decision. The advisor receives your full conversation transcript automatically. Use this when you are uncertain about the next step.",
    inputSchema: z.object({
      question: z
        .string()
        .describe("The question or problem to ask the advisor"),
    }),
    execute: async (
      input: { question: string },
      options?: { messages?: unknown; abortSignal?: AbortSignal },
    ) => {
      if (maxUses !== undefined && usageCount >= maxUses) {
        return `[Advisor unavailable: maximum uses (${maxUses}) reached]`;
      }

      usageCount++;

      const messages: ModelMessage[] = (options?.messages ?? []) as ModelMessage[];

      const truncated = formatConversation(messages, contextLimit);

      const prompt = truncated
        ? `## Conversation\n${truncated}\n\n## Question\n${input.question}`
        : `## Question\n${input.question}`;

      try {
        const result = await generateText({
          model,
          system: systemPrompt,
          prompt,
          abortSignal: options?.abortSignal,
          toolChoice: "none",
        });

        return result.text.trim() || "[Advisor returned empty response]";
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          options?.abortSignal &&
          (err as { name?: string }).name === "AbortError"
        ) {
          return "[Advisor call was aborted]";
        }
        return `[Advisor error: ${message}]`;
      }
    },
  };

  return {
    tool: advisorTool,
    get usageCount() {
      return usageCount;
    },
    resetUsage() {
      usageCount = 0;
    },
  };
}
