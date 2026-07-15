import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "ai";
import { z } from "zod";
import { resolvePath, isSkipDir, limitedWireFormat } from "./utils.js";
import type { FileToolsOptions } from "./types.js";
import { resolveOptions } from "./types.js";

function walkDir(
  dir: string,
  pattern: RegExp,
  skipDirs: string[],
): string[] {
  const results: string[] = [];
  const stack: string[] = [dir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const fullPath = path.join(current, ent.name);

      if (ent.isDirectory()) {
        if (isSkipDir(ent.name, skipDirs)) continue;
        stack.push(fullPath);
      } else if (ent.isFile()) {
        if (pattern.test(ent.name)) {
          results.push(fullPath);
        }
      }
    }
  }

  results.sort();
  return results;
}

export const findFilesInputSchema = z.object({
  pattern: z.string().describe("Regex pattern to match file names against"),
  path: z
    .string()
    .optional()
    .describe("Directory to search in (defaults to cwd)"),
});

export function createFindFilesTool(options?: FileToolsOptions): Tool {
  const opts = resolveOptions(options);

  return {
    description:
      "Recursively find files matching a regex pattern in their filename. Respects .gitignore. Skips node_modules and target.",
    inputSchema: findFilesInputSchema,
    execute: async (input: z.infer<typeof findFilesInputSchema>, _opts?: unknown) => {
      const target = resolvePath(input.path ?? ".", opts.cwd);

      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error: invalid regex pattern: ${message}`;
      }

      try {
        if (!fs.existsSync(target)) {
          return `Error: path not found: ${target}`;
        }
        const stat = fs.statSync(target);
        if (!stat.isDirectory()) {
          return `Error: not a directory: ${target}`;
        }

        const results = walkDir(target, regex, opts.skipDirs);

        if (results.length === 0) {
          return "0 files found";
        }

        const relResults = results.map((r) => {
          const rel = path.relative(opts.cwd, r);
          return rel.startsWith("..") ? r : rel;
        });

        return limitedWireFormat(relResults, opts.maxResults, "file", "files");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error searching files: ${message}`;
      }
    },
  };
}
