import type { Tool } from "ai";
import { z } from "zod";

export const bashToolSchema = z.object({
  // placeholder
});

export type BashToolOptions = z.infer<typeof bashToolSchema>;

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function bashTool(options?: BashToolOptions): Tool {
  throw new Error("not implemented");
}
