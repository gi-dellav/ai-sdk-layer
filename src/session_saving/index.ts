import { z } from "zod";

export const sessionSchema = z.object({
  // placeholder
});

export type Session = z.infer<typeof sessionSchema>;

export interface SessionStore {
  save(session: Session): Promise<void>;
  load(sessionId: string): Promise<Session | null>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<Session[]>;
}

export function createSessionStore(
  storage: "memory" | "fs" | "db",
): SessionStore {
  throw new Error("not implemented");
}
