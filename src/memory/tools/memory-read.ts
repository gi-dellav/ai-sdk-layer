import type { Tool } from "ai";
import { z } from "zod";
import { Mem } from "../store.js";
import { memoryReadInputSchema } from "../types.js";
import type { MemoryConfig } from "../types.js";

export function createMemoryReadTool(
  mem: Mem,
  _config?: MemoryConfig,
): Tool {
  return {
    description:
      "Read a memory file. " +
      "Use source=long_term for global long-term memory, " +
      "source=scratchpad for the per-project checklist, " +
      "source=daily for a daily log (defaults to today, or specify name as YYYY-MM-DD), " +
      "source=note for a named note (specify name), " +
      "source=list to list available notes and daily logs.",
    inputSchema: memoryReadInputSchema,
    execute: async (
      input: z.infer<typeof memoryReadInputSchema>,
    ): Promise<string> => {
      const { source, name } = input;

      switch (source) {
        case "long_term": {
          const content = await mem.read(mem.longTermPath());
          if (content === null) return "(empty)";
          return content;
        }
        case "scratchpad": {
          const content = await mem.read(mem.scratchpadPath());
          if (content === null) return "(empty)";
          return content;
        }
        case "daily": {
          const date = name && mem.isSafeDailyName(name) ? name : mem.today;
          const content = await mem.read(mem.dailyPath(date));
          if (content === null) return `(no daily log for ${date})`;
          return content;
        }
        case "note": {
          if (!name) return "Error: 'name' is required for source='note'";
          const content = await mem.read(mem.notePath(name));
          if (content === null) return `(no note named '${name}')`;
          return content;
        }
        case "list": {
          const notes = await mem.listNotes();
          const dailies = await mem.listDailyFiles();
          const lines: string[] = [];
          lines.push("## Notes");
          if (notes.length === 0) {
            lines.push("(none)");
          } else {
            for (const n of notes) lines.push(`- ${n}`);
          }
          lines.push("");
          lines.push("## Daily Logs");
          if (dailies.length === 0) {
            lines.push("(none)");
          } else {
            for (const d of dailies.slice(0, 30)) lines.push(`- ${d}`);
            if (dailies.length > 30) {
              lines.push(`  ... and ${dailies.length - 30} more`);
            }
          }
          return lines.join("\n");
        }
      }
    },
  };
}
