import type { Tool } from "ai";
import { z } from "zod";

export const subagentSchema = z.object({
  // placeholder
});

export type SubagentOptions = z.infer<typeof subagentSchema>;

export function subagent(options: SubagentOptions): Tool {
  throw new Error("not implemented");
}

export function createSubagent(options: SubagentOptions): Tool {
  throw new Error("not implemented");
}
