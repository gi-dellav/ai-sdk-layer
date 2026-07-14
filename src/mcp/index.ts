import { z } from "zod";

export const mcpServerSchema = z.object({
  // placeholder
});

export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export interface McpClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export function createMcpClient(config: McpServerConfig): McpClient {
  throw new Error("not implemented");
}
