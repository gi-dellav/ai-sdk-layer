import { z } from "zod";

export const memorySchema = z.object({
  // placeholder
});

export type Memory = z.infer<typeof memorySchema>;

export interface MemoryStore {
  store(key: string, value: unknown): Promise<void>;
  retrieve(key: string): Promise<unknown | null>;
  search(query: string): Promise<Memory[]>;
  forget(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function createMemoryStore(
  backend?: "memory" | "vector" | "db",
): MemoryStore {
  throw new Error("not implemented");
}
