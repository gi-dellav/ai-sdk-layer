// Types
export {
  MemoryConfigSchema,
  memoryWriteInputSchema,
  memoryEditInputSchema,
  memoryReadInputSchema,
  memorySearchInputSchema,
} from "./types.js";
export type {
  MemoryConfig,
  ResolvedMemoryConfig,
  WriteTarget,
  WriteMode,
  SearchHit,
  DailyLog,
  Section,
} from "./types.js";

// Core store
export { Mem } from "./store.js";

// Context assembly
export { contextBlock } from "./context.js";

// Search
export { search, SearchResults } from "./search.js";

// Tools
export { createMemoryTools } from "./tools/index.js";
export type { MemoryToolsOptions } from "./tools/index.js";

// Integration helpers
export {
  MEMORY_TOOLS_PROMPT,
  getContextBlock,
  effectiveReserve,
  flushCompactionSummary,
} from "./integration.js";

// Simple key-value store (for lightweight use cases)
import { z } from "zod";

export const memorySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  timestamp: z.number(),
});

export type Memory = z.infer<typeof memorySchema>;

export interface MemoryStore {
  store(key: string, value: unknown): Promise<void>;
  retrieve(key: string): Promise<unknown | null>;
  search(query: string): Promise<Memory[]>;
  forget(key: string): Promise<void>;
  clear(): Promise<void>;
}

const _backends = ["memory", "vector", "db"] as const;

export function createMemoryStore(
  _backend?: "memory" | "vector" | "db",
): MemoryStore {
  const store = new Map<string, Memory>();

  return {
    async store(key: string, value: unknown): Promise<void> {
      store.set(key, { key, value, timestamp: Date.now() });
    },
    async retrieve(key: string): Promise<unknown | null> {
      const m = store.get(key);
      return m ? m.value : null;
    },
    async search(_query: string): Promise<Memory[]> {
      return Array.from(store.values());
    },
    async forget(key: string): Promise<void> {
      store.delete(key);
    },
    async clear(): Promise<void> {
      store.clear();
    },
  };
}
