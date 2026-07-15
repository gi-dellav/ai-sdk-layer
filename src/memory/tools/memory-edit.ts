import type { Tool } from "ai";
import { z } from "zod";
import { Mem } from "../store.js";
import { memoryEditInputSchema } from "../types.js";
import type { MemoryConfig } from "../types.js";
import * as fs from "node:fs";
import * as path from "node:path";

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, content, "utf-8");
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ok */ }
    throw new Error(`Failed to atomically write ${filePath}`);
  }
}

function backupFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  fs.copyFileSync(filePath, filePath.replace(/\.md$/, ".bak"));
}

export function createMemoryEditTool(
  mem: Mem,
  _config?: MemoryConfig,
): Tool {
  return {
    description:
      "Edit a memory file by replacing a unique substring. " +
      "The old_str must match exactly once in the target file. " +
      "Omit old_str (or provide empty) on a 'note' target to delete the entire note file. " +
      "Targets: long_term, scratchpad, note.",
    inputSchema: memoryEditInputSchema,
    execute: async (
      input: z.infer<typeof memoryEditInputSchema>,
    ): Promise<string> => {
      const { target, old_str: oldStr, new_str: newStr, name: noteName } = input;

      if (target === "note" && !noteName) {
        return "Error: 'name' is required when target is 'note'";
      }

      let filePath: string;
      switch (target) {
        case "long_term": filePath = mem.longTermPath(); break;
        case "scratchpad": filePath = mem.scratchpadPath(); break;
        case "note": filePath = mem.notePath(noteName!); break;
        default: return `Error: edit not supported for target '${target}'`;
      }

      const existing = await mem.read(filePath);
      if (existing === null) {
        return "Error: file not found";
      }

      if (!oldStr || oldStr.trim() === "") {
        if (target === "note") {
          try { fs.unlinkSync(filePath); return `Deleted note: ${noteName}`; }
          catch (e: unknown) { return `Error deleting note: ${e instanceof Error ? e.message : String(e)}`; }
        }
        return "Error: old_str is required for long_term and scratchpad";
      }

      const idx = existing.indexOf(oldStr);
      if (idx === -1) {
        return "Error: old_str not found. Provide the exact substring to replace.";
      }
      const secondIdx = existing.indexOf(oldStr, idx + 1);
      if (secondIdx !== -1) {
        return "Error: old_str matches multiple locations. Provide a larger, unique substring.";
      }

      const updated = existing.slice(0, idx) + newStr + existing.slice(idx + oldStr.length);

      if (target === "long_term" || target === "scratchpad") {
        backupFile(filePath);
      }
      atomicWrite(filePath, updated);
      const rel = path.relative(mem.root, filePath);
      return `Replaced 1 occurrence in ${rel}`;
    },
  };
}
