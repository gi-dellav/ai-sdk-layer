import type { Tool } from "ai";
import { z } from "zod";

export type { CreateBashToolOptions, BashToolkit } from "bash-tool";
export type { BashOptions } from "just-bash";

export const fileToolsSchema = z.object({
  // placeholder
});

export type FileToolsOptions = z.infer<typeof fileToolsSchema>;

export function fileTools(options?: FileToolsOptions): Tool {
  throw new Error("not implemented");
}
