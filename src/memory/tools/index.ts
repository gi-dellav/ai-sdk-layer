import type { ToolSet } from "ai";
import { Mem } from "../store.js";
import type { MemoryConfig } from "../types.js";
import { createMemoryWriteTool } from "./memory-write.js";
import { createMemoryEditTool } from "./memory-edit.js";
import { createMemoryReadTool } from "./memory-read.js";
import { createMemorySearchTool } from "./memory-search.js";

export interface MemoryToolsOptions {
  mem: Mem;
  config?: MemoryConfig;
  readOnly?: boolean;
}

export function createMemoryTools(opts: MemoryToolsOptions): ToolSet {
  const { mem, config, readOnly } = opts;

  const tools: ToolSet = {
    memory_read: createMemoryReadTool(mem, config),
    memory_search: createMemorySearchTool(mem, config),
  };

  if (!readOnly) {
    tools["memory_write"] = createMemoryWriteTool(mem, config);
    tools["memory_edit"] = createMemoryEditTool(mem, config);
  }

  return tools;
}
