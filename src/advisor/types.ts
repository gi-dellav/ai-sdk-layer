import { z } from "zod";

export const advisorConfigSchema = z.object({
  systemPrompt: z.string().optional(),
  maxUses: z.number().int().positive().optional(),
  contextLimit: z.number().int().positive().default(256),
  description: z.string().optional(),
});

export type AdvisorConfig = z.infer<typeof advisorConfigSchema>;
