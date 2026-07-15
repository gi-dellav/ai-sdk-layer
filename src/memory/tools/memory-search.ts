import type { Tool } from "ai";
import { z } from "zod";
import { Mem } from "../store.js";
import { memorySearchInputSchema } from "../types.js";
import type { MemoryConfig } from "../types.js";
import { search } from "../search.js";

export function createMemorySearchTool(
  mem: Mem,
  config?: MemoryConfig,
): Tool {
  return {
    description:
      "Case-insensitive keyword search over all memory files. " +
      "Returns ranked results with context windows. " +
      "Searches long-term memory, all notes, and all daily logs.",
    inputSchema: memorySearchInputSchema,
    execute: async (
      input: z.infer<typeof memorySearchInputSchema>,
    ): Promise<string> => {
      const maxBytes = config?.maxSearchBytes ?? mem.maxSearchBytes;
      const results = await search(mem, input.query);
      return results.render(maxBytes);
    },
  };
}
