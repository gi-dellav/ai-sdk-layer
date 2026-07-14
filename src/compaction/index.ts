import { z } from "zod";

export const compactionConfigSchema = z.object({
  // placeholder
});

export type CompactionConfig = z.infer<typeof compactionConfigSchema>;

export interface CompactionResult {
  compacted: string;
  tokensSaved: number;
}

export function compactMessages(
  config: CompactionConfig,
): Promise<CompactionResult> {
  throw new Error("not implemented");
}
