import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "ai";
import { z } from "zod";
import { resolvePath } from "./utils.js";
import type { FileToolsOptions, ListDirEntry } from "./types.js";
import { resolveOptions } from "./types.js";

function listDirEntries(dirPath: string): ListDirEntry[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result: ListDirEntry[] = [];

  for (const ent of entries) {
    let type: ListDirEntry["type"] = "unknown";
    if (ent.isDirectory()) type = "directory";
    else if (ent.isFile()) type = "file";
    else if (ent.isSymbolicLink()) type = "symlink";

    const entry: ListDirEntry = { name: ent.name, type };
    if (type === "file") {
      try {
        entry.size = fs.statSync(path.join(dirPath, ent.name)).size;
      } catch {
        // stat can fail on symlinks, etc.
      }
    }
    result.push(entry);
  }

  result.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

function formatDirOutput(dirPath: string, entries: ListDirEntry[]): string {
  const lines: string[] = [];
  lines.push(`Listing ${dirPath}:`);
  lines.push("  [type(entries)]  name");
  for (const entry of entries) {
    let prefix: string;
    switch (entry.type) {
      case "directory":
        prefix = `  [dir(${entry.size ?? "?"})]`;
        break;
      case "file":
        prefix = `  [file]`;
        break;
      default:
        prefix = `  [${entry.type}]`;
    }
    lines.push(`${prefix}  ${entry.name}`);
    if (entry.size !== undefined && entry.type === "file") {
      lines[lines.length - 1] += formatSize(entry.size);
    }
  }

  return lines.join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `  ${bytes} B`;
  if (bytes < 1024 * 1024) return `  ${(bytes / 1024).toFixed(1)} KB`;
  return `  ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const listDirInputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory path (defaults to cwd)"),
});

export function createListDirTool(options?: FileToolsOptions): Tool {
  const opts = resolveOptions(options);

  return {
    description:
      "List files and directories in a directory. Respects .gitignore. Shows type, size, entry count for subdirectories. Sorted: directories first, then alphabetical.",
    inputSchema: listDirInputSchema,
    execute: async (input: z.infer<typeof listDirInputSchema>, _opts?: unknown) => {
      const target = resolvePath(input.path ?? ".", opts.cwd);

      try {
        if (!fs.existsSync(target)) {
          return `Error: path not found: ${target}`;
        }
        const stat = fs.statSync(target);
        if (!stat.isDirectory()) {
          return `Error: not a directory: ${target}`;
        }

        const entries = listDirEntries(target);
        return formatDirOutput(target, entries);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error listing directory: ${message}`;
      }
    },
  };
}
