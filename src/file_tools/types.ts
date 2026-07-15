import { z } from "zod";

export const fileToolsOptionsSchema = z.object({
  cwd: z.string().default(process.cwd()),
  maxResults: z.number().int().positive().default(200),
  maxFileSize: z.number().int().positive().default(10 * 1024 * 1024),
  fuzzyThreshold: z.number().min(0).max(1).default(0.85),
  skipDirs: z.array(z.string()).default(["node_modules", "target"]),
});

export type FileToolsOptions = z.infer<typeof fileToolsOptionsSchema>;

export const resolvedOptionsSchema = fileToolsOptionsSchema.transform((o) => ({
  ...o,
  cwd: o.cwd,
}));

export type ResolvedOptions = z.infer<typeof resolvedOptionsSchema>;

export interface EditBlock {
  search: string;
  replace: string;
}

export interface EditMatch {
  blockIndex: number;
  start: number;
  end: number;
  method: "exact" | "whitespace" | "fuzzy";
  similarity?: number;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
  isContext: boolean;
}

export interface ListDirEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "unknown";
  size?: number;
}

export function resolveOptions(raw?: FileToolsOptions): ResolvedOptions {
  return resolvedOptionsSchema.parse(raw ?? {});
}
