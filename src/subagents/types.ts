import { z } from "zod";

export const taskInputSchema = z.object({
  prompts: z
    .array(
      z
        .string()
        .min(1)
        .describe("Investigation prompt for a single subagent"),
    )
    .min(1)
    .max(10)
    .describe(
      "One string per independent investigation. Multiple prompts run in parallel.",
    ),
});

export type TaskInput = z.infer<typeof taskInputSchema>;

export const subagentConfigSchema = z.object({
  taskEnabled: z.boolean().default(true),
  maxTurns: z.number().int().positive().default(20),
  timeoutMs: z.number().int().positive().default(300_000),
  maxResponseBytes: z.number().int().positive().default(131_072),
  maxReadLines: z.number().int().positive().default(2000),
  maxGrepResults: z.number().int().positive().default(200),
  maxFindResults: z.number().int().positive().default(200),
  architecture: z.string().optional(),
});

export type SubagentConfig = z.infer<typeof subagentConfigSchema>;

export interface SubagentResult {
  index: number;
  prompt: string;
  response: string;
}
