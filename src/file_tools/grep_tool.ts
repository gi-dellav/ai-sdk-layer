import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "ai";
import { z } from "zod";
import {
  resolvePath,
  globToRegex,
  isBinaryFile,
  isSkipDir,
  formatGrepOutput,
} from "./utils.js";
import type { FileToolsOptions, GrepMatch } from "./types.js";
import { resolveOptions } from "./types.js";

function searchFile(
  filePath: string,
  regex: RegExp,
  includePattern: RegExp | null,
  maxFileSize: number,
): { lines: string[]; matches: GrepMatch[] } | null {
  if (includePattern && !includePattern.test(path.basename(filePath))) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > maxFileSize) return null;

  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (isBinaryFile(buf)) return null;

  const content = buf.toString("utf-8");
  const lines = content.split("\n");

  const matches: GrepMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = regex.test(lines[i]);
    if (match) {
      matches.push({
        file: filePath,
        line: i + 1,
        text: lines[i],
        isContext: false,
      });
    }
  }

  if (matches.length === 0) return null;
  return { lines, matches };
}

function walkAndSearch(
  dir: string,
  regex: RegExp,
  includePattern: RegExp | null,
  maxFileSize: number,
  skipDirs: string[],
): Array<{ file: string; lines: string[]; matches: GrepMatch[] }> {
  const results: Array<{ file: string; lines: string[]; matches: GrepMatch[] }> = [];
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
        const result = searchFile(fullPath, regex, includePattern, maxFileSize);
        if (result) {
          results.push({ file: fullPath, ...result });
        }
      }
    }
  }

  return results;
}

export const grepInputSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for (Rust regex syntax)"),
  path: z
    .string()
    .optional()
    .describe("Directory to search in (defaults to cwd)"),
  include: z
    .string()
    .optional()
    .describe("File glob pattern to filter filenames (e.g. '*.rs', '*.{ts,tsx}')"),
  context_lines: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Number of context lines before/after each match (like grep -C)"),
});

export function createGrepTool(options?: FileToolsOptions): Tool {
  const opts = resolveOptions(options);

  return {
    description:
      "Search file contents using a regex pattern (Rust regex syntax). Respects .gitignore. Skips binary files, node_modules, and target.",
    inputSchema: grepInputSchema,
    execute: async (input: z.infer<typeof grepInputSchema>, _opts?: unknown) => {
      const target = resolvePath(input.path ?? ".", opts.cwd);
      const contextLines = input.context_lines ?? 0;

      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error: invalid regex pattern: ${message}`;
      }

      let includePattern: RegExp | null = null;
      if (input.include) {
        try {
          includePattern = globToRegex(input.include);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return `Error: invalid include glob pattern: ${message}`;
        }
      }

      try {
        if (!fs.existsSync(target)) {
          return `Error: path not found: ${target}`;
        }
        const stat = fs.statSync(target);
        if (!stat.isDirectory()) {
          return `Error: not a directory: ${target}`;
        }

        const fileResults = walkAndSearch(
          target,
          regex,
          includePattern,
          opts.maxFileSize,
          opts.skipDirs,
        );

        if (fileResults.length === 0) {
          return "0 matches found";
        }

        const outputs: string[] = [];
        let totalMatches = 0;

        for (const fr of fileResults) {
          const relPath =
            path.relative(opts.cwd, fr.file).startsWith("..")
              ? fr.file
              : path.relative(opts.cwd, fr.file);

          if (contextLines > 0) {
            const nonContextMatches = fr.matches.filter((m) => !m.isContext);
            if (nonContextMatches.length === 0) continue;

            const matchLines = nonContextMatches.map((m) => m.line);
            const allMatches = fr.matches;

            if (contextLines > 0) {
              const merged = new Set<number>();
              for (const ml of matchLines) {
                for (let l = Math.max(1, ml - contextLines); l <= Math.min(fr.lines.length, ml + contextLines); l++) {
                  merged.add(l);
                }
              }

              const sortedMatchLines = [...merged].sort((a, b) => a - b);

              for (const l of sortedMatchLines) {
                const isMatch = nonContextMatches.some((m) => m.line === l);
                const sep = isMatch ? ":" : "-";
                outputs.push(`${relPath}${sep}${l}${sep}${fr.lines[l - 1]}`);
              }

              totalMatches += nonContextMatches.length;
            }
          } else {
            for (const m of fr.matches) {
              outputs.push(`${relPath}:${m.line}:${m.text}`);
              totalMatches++;
            }
          }
        }

        if (totalMatches > opts.maxResults) {
          const truncated = outputs.slice(0, opts.maxResults);
          truncated.push(
            `[truncated after ${opts.maxResults} matches — ${totalMatches - opts.maxResults} more matches; narrow the pattern or restrict to a path]`,
          );
          return truncated.join("\n");
        }

        return outputs.join("\n");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error searching files: ${message}`;
      }
    },
  };
}
