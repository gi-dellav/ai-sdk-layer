import { type Tool, generateText, stepCountIs } from "ai";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileTools, fileToolsOptionsSchema } from "../file_tools/index.js";
import {
  taskInputSchema,
  subagentConfigSchema,
  type TaskInput,
  type SubagentConfig,
} from "./types.js";
import { EXPLORE_PROMPT } from "./prompt.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(config: SubagentConfig): string {
  let prompt = EXPLORE_PROMPT;
  if (config.architecture) {
    prompt += `\n\n## Project Architecture\n\n${config.architecture}`;
  }
  return prompt;
}

function truncateResponse(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return (
    text.slice(0, lo) + `\n…[subagent response truncated at ${maxBytes}B]`
  );
}

function combineResults(
  results: Array<{ index: number; prompt: string; response: string }>,
): string {
  if (results.length === 1) {
    return results[0].response;
  }

  const sorted = [...results].sort((a, b) => a.index - b.index);
  let output = "";
  for (const r of sorted) {
    const preview =
      r.prompt.length > 60 ? r.prompt.slice(0, 57) + "..." : r.prompt;
    output += `## Task ${r.index + 1}: ${preview}\n\n${r.response}\n\n`;
  }
  return output.trimEnd() + "\n";
}

function timeoutSignal(ms: number, parentSignal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException("timeout", "TimeoutError")),
    ms,
  );

  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timeoutId);
      return AbortSignal.abort(parentSignal.reason);
    }
    parentSignal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutId);
        controller.abort(parentSignal.reason);
      },
      { once: true },
    );
  }

  return controller.signal;
}

// ---------------------------------------------------------------------------
// Read tool (read-only, no edit capability)
// ---------------------------------------------------------------------------

function createReadTool(maxLines: number): Tool {
  return {
    description:
      "Read the contents of a file. Supports text files. Defaults to first 2000 lines. Use offset/limit for large files.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file (relative or absolute)"),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Line number to start from (1-indexed)"),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum number of lines to read"),
    }),
    execute: async (input: {
      path: string;
      offset?: number;
      limit?: number;
    }) => {
      try {
        const resolved = path.isAbsolute(input.path)
          ? input.path
          : path.resolve(process.cwd(), input.path);
        const content = await fs.readFile(resolved, "utf-8");
        const lines = content.split("\n");
        const start = (input.offset ?? 1) - 1;
        const end = input.limit
          ? start + input.limit
          : Math.min(start + maxLines, lines.length);
        const selected = lines.slice(start, end);
        return selected.join("\n");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `Error reading file: ${msg}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

// Exported for unit testing.
export { buildSystemPrompt, truncateResponse, combineResults };

export interface TaskToolOptions {
  /** The LLM to use for every subagent. */
  model: unknown; // LanguageModel from ai — uses unknown to avoid coupling
  /** Optional overrides for defaults (maxTurns, timeoutMs, etc.). */
  config?: Partial<SubagentConfig>;
  /** Called for each tool call a subagent makes (for TUI integration). */
  onToolCall?: (
    promptIndex: number,
    toolName: string,
    input: unknown,
  ) => void;
}

/**
 * Creates the `task` tool: spawns multiple read-only, parallel, independent
 * subagents for code investigation. Each subagent has its own model, a
 * restricted tool palette (read, grep, find_files, list_dir), and a timeout.
 * Results are collected and returned as a single Markdown output.
 */
export function createTaskTool(options: TaskToolOptions): Tool {
  const config = subagentConfigSchema.parse(options.config ?? {});
  const systemPrompt = buildSystemPrompt(config);

  // Build file tools with subagent-specific limits, then strip the edit tool.
  const ftOptions = fileToolsOptionsSchema.parse({
    maxResults: config.maxGrepResults,
  });
  const { edit: _edit, ...readOnlyFileTools } = fileTools(ftOptions);
  const readTool = createReadTool(config.maxReadLines);
  const tools = { ...readOnlyFileTools, read: readTool };

  return {
    description:
      "Spawn multiple read-only, parallel, independent LLM agents for code investigation. " +
      "Each subagent has its own model, a restricted tool palette (read, grep, find_files, list_dir), " +
      "and a timeout. Results are collected into a single Markdown output. " +
      "Use for cross-file tasks: find all X, where Y is used, how does Z work.",
    inputSchema: taskInputSchema,
    execute: async (
      input: TaskInput,
      toolOptions?: { abortSignal?: AbortSignal },
    ) => {
      const { prompts } = input;
      const parentSignal = toolOptions?.abortSignal;

      const promises = prompts.map(async (promptText, idx) => {
        try {
          const signal = timeoutSignal(config.timeoutMs, parentSignal);

          const result = await generateText({
            model: options.model as Parameters<
              typeof generateText
            >[0]["model"],
            system: systemPrompt,
            messages: [{ role: "user", content: promptText }],
            tools,
            stopWhen: stepCountIs(config.maxTurns),
            abortSignal: signal,
          });

          const text = result.text?.trim();
          if (!text) {
            return {
              index: idx,
              prompt: promptText,
              response: "[error: subagent returned empty response]",
            };
          }

          return {
            index: idx,
            prompt: promptText,
            response: truncateResponse(text, config.maxResponseBytes),
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (
            (e instanceof DOMException && e.name === "TimeoutError") ||
            msg.includes("timeout") ||
            msg.includes("abort")
          ) {
            return {
              index: idx,
              prompt: promptText,
              response: `[timeout: subagent exceeded ${config.timeoutMs / 1000}s]`,
            };
          }
          return {
            index: idx,
            prompt: promptText,
            response: `[error: ${msg}]`,
          };
        }
      });

      const settled = await Promise.allSettled(promises);

      const results: Array<{
        index: number;
        prompt: string;
        response: string;
      }> = [];
      for (const s of settled) {
        if (s.status === "fulfilled") {
          results.push(s.value);
        } else {
          results.push({
            index: 0,
            prompt: "",
            response: `[task panicked: ${String(s.reason)}]`,
          });
        }
      }

      return combineResults(results);
    },
  };
}
