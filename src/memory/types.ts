import { z } from "zod";

export const MemoryConfigSchema = z.object({
  baseDir: z.string().optional(),
  maxInjectBytes: z.number().int().positive().default(32 * 1024),
  maxWriteBytes: z.number().int().positive().default(64 * 1024),
  maxSearchBytes: z.number().int().positive().default(32 * 1024),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export type ResolvedMemoryConfig = {
  baseDir: string;
  maxInjectBytes: number;
  maxWriteBytes: number;
  maxSearchBytes: number;
};

export type WriteTarget = "long_term" | "scratchpad" | "daily" | "note";

export type WriteMode = "append" | "overwrite";

export const memoryWriteInputSchema = z.object({
  target: z
    .enum(["long_term", "scratchpad", "daily", "note"])
    .describe("Where to write: long_term, scratchpad, daily, or note"),
  content: z.string().describe("Content to write"),
  mode: z
    .enum(["append", "overwrite"])
    .default("append")
    .describe("Append or overwrite"),
  name: z
    .string()
    .optional()
    .describe("Note name (required if target is 'note')"),
});

export const memoryEditInputSchema = z.object({
  target: z
    .enum(["long_term", "scratchpad", "note"])
    .describe("Which memory file to edit"),
  old_str: z
    .string()
    .optional()
    .describe(
      "Exact substring to replace. Must match exactly once. Omit to delete an entire note file.",
    ),
  new_str: z
    .string()
    .default("")
    .describe("Replacement text (empty string deletes the matched substring)"),
  name: z
    .string()
    .optional()
    .describe("Note name (required if target is 'note')"),
});

export const memoryReadInputSchema = z.object({
  source: z
    .enum(["long_term", "scratchpad", "daily", "note", "list"])
    .describe(
      "What to read: long_term, scratchpad, daily, note, or list (list available notes)",
    ),
  name: z.string().optional().describe("Note name or daily date (YYYY-MM-DD)"),
});

export const memorySearchInputSchema = z.object({
  query: z.string().describe("Search query (case-insensitive, multi-term)"),
});

export interface SearchHit {
  path: string;
  matchedTerms: string[];
  body: string;
  contentMatch: boolean;
  matchCount: number;
  isDaily: boolean;
  dateStr?: string;
}

export interface DailyLog {
  date: string;
  content: string;
}

export interface Section {
  title: string;
  body: string;
}
