import { z } from "zod";

export const permissionRuleSchema = z.object({
  // placeholder
});

export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export interface PermissionCheck {
  allowed: boolean;
  reason?: string;
}

export interface PermissionStore {
  grant(rule: PermissionRule): void;
  revoke(ruleId: string): void;
  check(action: string, resource?: string): PermissionCheck;
  list(): PermissionRule[];
}

export function createPermissionStore(): PermissionStore {
  throw new Error("not implemented");
}
