import { z } from "zod";

export const slashCommandSchema = z.object({
  // placeholder
});

export type SlashCommand = z.infer<typeof slashCommandSchema>;

export interface SlashCommandResult {
  output: string;
  metadata?: Record<string, unknown>;
}

export interface SlashCommandHandler {
  execute(input: string): Promise<SlashCommandResult>;
}

export function createSlashCommandParser(): {
  parse(input: string): { command: string; args: string[] } | null;
  register(name: string, handler: SlashCommandHandler): void;
  unregister(name: string): void;
  execute(input: string): Promise<SlashCommandResult>;
} {
  throw new Error("not implemented");
}
