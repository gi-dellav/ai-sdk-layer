import type { Tool } from "ai";
import { z } from "zod";
import { Mem } from "../store.js";
import { memoryWriteInputSchema } from "../types.js";
import type { MemoryConfig } from "../types.js";

export function createMemoryWriteTool(
  mem: Mem,
  _config?: MemoryConfig,
): Tool {
  return {
    description:
      "Persist content to memory. " +
      "Use target=long_term for curated facts (auto-dedup on append), " +
      "target=scratchpad for per-project checklist, " +
      "target=daily for timestamped daily logs, " +
      "target=note for named reference notes. " +
      "Default mode is append. Use overwrite to replace the entire file.",
    inputSchema: memoryWriteInputSchema,
    execute: async (
      input: z.infer<typeof memoryWriteInputSchema>,
    ): Promise<string> => {
      const { target, content, mode, name: noteName } = input;

      if (target === "note" && !noteName) {
        return "Error: 'name' is required when target is 'note'";
      }

      let filePath: string;
      switch (target) {
        case "long_term":
          filePath = mem.longTermPath();
          break;
        case "scratchpad":
          filePath = mem.scratchpadPath();
          break;
        case "daily":
          filePath = mem.todayPath();
          break;
        case "note":
          filePath = mem.notePath(noteName!);
          break;
      }

      return mem.write(filePath, content, mode, target);
    },
  };
}
