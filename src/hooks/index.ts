import { z } from "zod";

export const hookSchema = z.object({
  // placeholder
});

export type Hook = z.infer<typeof hookSchema>;

export type HookEvent =
  | "before:tool_call"
  | "after:tool_call"
  | "before:generate"
  | "after:generate"
  | "on:error";

export interface HookContext {
  // placeholder
}

export function createHookSystem(): {
  register(event: HookEvent, hook: Hook): void;
  unregister(event: HookEvent, hook: Hook): void;
  trigger(event: HookEvent, context: HookContext): Promise<void>;
} {
  throw new Error("not implemented");
}
