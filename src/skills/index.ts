import { z } from "zod";

export const skillSchema = z.object({
  // placeholder
});

export type Skill = z.infer<typeof skillSchema>;

export interface SkillRegistry {
  register(skill: Skill): void;
  unregister(name: string): void;
  list(): Skill[];
  find(name: string): Skill | undefined;
}

export function createSkillRegistry(): SkillRegistry {
  throw new Error("not implemented");
}
