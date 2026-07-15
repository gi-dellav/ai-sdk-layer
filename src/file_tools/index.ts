import type { ToolSet } from "ai";
import { z } from "zod";
import { createEditTool } from "./edit_tool.js";
import { createFindFilesTool } from "./find_files.js";
import { createGrepTool } from "./grep_tool.js";
import { createListDirTool } from "./list_dir.js";
import { fileToolsOptionsSchema } from "./types.js";

export type { FileToolsOptions } from "./types.js";
export { fileToolsOptionsSchema } from "./types.js";

export function fileTools(
  options?: z.infer<typeof fileToolsOptionsSchema>,
): ToolSet {
  const resolved = fileToolsOptionsSchema.parse(options ?? {});

  return {
    edit: createEditTool(resolved),
    find_files: createFindFilesTool(resolved),
    grep: createGrepTool(resolved),
    list_dir: createListDirTool(resolved),
  };
}
