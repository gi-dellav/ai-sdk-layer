import { z } from "zod";

export const advisorConfigSchema = z.object({
  // placeholder
});

export type AdvisorConfig = z.infer<typeof advisorConfigSchema>;

export interface AdvisorResult {
  advice: string;
  reasoning: string;
}

export function createAdvisor(config?: AdvisorConfig): {
  consult(prompt: string): Promise<AdvisorResult>;
} {
  throw new Error("not implemented");
}
