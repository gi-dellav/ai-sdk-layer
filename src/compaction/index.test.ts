import { describe, it, expect } from "vitest";
import {
  compactionConfigSchema,
  estimateTokens,
  estimateMessageTokens,
  selectCompactionCut,
  needsCompaction,
  serializeConversation,
  buildCompactionPrompt,
  applyCompaction,
  type CompactionConfig,
  type CompactionResult,
  type ModelMessage,
} from "./index.js";

function msg(role: string, content: string): ModelMessage {
  return { role, content } as ModelMessage;
}

describe("compactionConfigSchema", () => {
  it("fills defaults on empty input", () => {
    const cfg = compactionConfigSchema.parse({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.keepRecent).toBe(4000);
    expect(cfg.reserveTokens).toBe(2000);
    expect(cfg.contextWindow).toBe(0);
    expect(cfg.midTurnCompactThreshold).toBe(0);
    expect(cfg.summaryRole).toBe("assistant");
    expect(cfg.summaryPrefix).toBe("[Recap of my prior work in this conversation]");
  });

  it("accepts partial overrides", () => {
    const cfg = compactionConfigSchema.parse({ keepRecent: 2000, summaryRole: "system" });
    expect(cfg.keepRecent).toBe(2000);
    expect(cfg.summaryRole).toBe("system");
    expect(cfg.enabled).toBe(true);
  });

  it("rejects midTurnCompactThreshold out of range", () => {
    expect(() => compactionConfigSchema.parse({ midTurnCompactThreshold: 1.5 })).toThrow();
    expect(() => compactionConfigSchema.parse({ midTurnCompactThreshold: -0.1 })).toThrow();
  });

  it("rejects invalid summaryRole", () => {
    expect(() => compactionConfigSchema.parse({ summaryRole: "user" })).toThrow();
  });
});

describe("estimateTokens", () => {
  it("estimates 1 token per 4 characters", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("12345678")).toBe(2);
  });
});

describe("estimateMessageTokens", () => {
  it("adds role overhead to content estimate", () => {
    const m = msg("user", "hello world"); // 11 chars → ceil(2.75) = 3 + 4 = 7
    expect(estimateMessageTokens(m)).toBe(7);
  });

  it("handles array content", () => {
    const m: ModelMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    } as ModelMessage;
    expect(estimateMessageTokens(m)).toBe(4 + 2); // 5 chars → 2 tokens
  });
});

describe("selectCompactionCut", () => {
  it("returns 0 for empty messages", () => {
    expect(selectCompactionCut([], 100)).toBe(0);
  });

  it("returns 0 when all messages fit within keepRecent", () => {
    const msgs = [msg("user", "hi"), msg("assistant", "hey")];
    expect(selectCompactionCut(msgs, 10000)).toBe(0);
  });

  it("returns cut index to keep recent messages within budget", () => {
    const msgs: ModelMessage[] = [];
    for (let i = 0; i < 100; i++) {
      msgs.push(msg("user", `message number ${i} with some content to make it longer`));
    }
    const cut = selectCompactionCut(msgs, 200);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(100);
  });

  it("returns cut >= 1 when keepRecent is 0", () => {
    // keepRecent=0 means first backward message triggers the cut,
    // so at most messages.length - 1 are kept.
    const msgs = [msg("user", "hello"), msg("assistant", "hi")];
    const cut = selectCompactionCut(msgs, 0);
    expect(cut).toBe(1);
  });
});

describe("needsCompaction", () => {
  it("returns false when contextWindow is 0", () => {
    expect(needsCompaction(10000, 0, 2000)).toBe(false);
  });

  it("returns false when under threshold", () => {
    expect(needsCompaction(5000, 10000, 2000)).toBe(false);
  });

  it("returns true when over threshold", () => {
    expect(needsCompaction(9000, 10000, 2000)).toBe(true);
  });

  it("returns true exactly at threshold", () => {
    expect(needsCompaction(8000, 10000, 2000)).toBe(false);
    expect(needsCompaction(8001, 10000, 2000)).toBe(true);
  });
});

describe("serializeConversation", () => {
  it("formats messages with role prefix", () => {
    const msgs = [
      msg("user", "Hello"),
      msg("assistant", "Hi there!"),
    ];
    const result = serializeConversation(msgs);
    expect(result).toBe("[User]: Hello\n\n[Assistant]: Hi there!");
  });

  it("handles array content", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }],
      } as ModelMessage,
    ];
    const result = serializeConversation(msgs);
    expect(result).toContain("[Assistant]: part one\npart two");
  });

  it("capitalizes role", () => {
    expect(serializeConversation([msg("system", "sys")])).toBe("[System]: sys");
    expect(serializeConversation([msg("tool", "out")])).toBe("[Tool]: out");
  });
});

describe("buildCompactionPrompt", () => {
  it("includes conversation and instructions", () => {
    const result = buildCompactionPrompt("convo text", null);
    expect(result).toContain("convo text");
    expect(result).toContain("Keep the summary concise but thorough.");
    expect(result).toContain("No previous summary.");
  });

  it("includes previous summary when provided", () => {
    const result = buildCompactionPrompt("convo", "prior summary");
    expect(result).toContain("prior summary");
    expect(result).toContain("Previous summary (for iterative context");
  });

  it("uses custom instructions", () => {
    const result = buildCompactionPrompt("convo", null, "be brief");
    expect(result).toContain("be brief");
  });
});

describe("applyCompaction", () => {
  it("returns original messages when summarizedCount is 0", () => {
    const msgs = [msg("user", "a"), msg("assistant", "b")];
    const result: CompactionResult = {
      summary: "",
      tokensSaved: 0,
      summarizedCount: 0,
      firstKeptIndex: 0,
    };
    expect(applyCompaction(msgs, result)).toBe(msgs);
  });

  it("replaces summarized messages with assistant-role summary by default", () => {
    const msgs = [
      msg("user", "very old message"),
      msg("assistant", "old reply"),
      msg("user", "recent"),
      msg("assistant", "recent reply"),
    ];
    const result: CompactionResult = {
      summary: "summarized content",
      tokensSaved: 50,
      summarizedCount: 2,
      firstKeptIndex: 2,
    };
    const applied = applyCompaction(msgs, result);
    expect(applied.length).toBe(3);
    expect(applied[0].role).toBe("assistant");
    expect(applied[0].content).toContain("summarized content");
    expect(applied[0].content).toContain("[Recap of my prior work in this conversation]");
    expect(applied[1]).toBe(msgs[2]);
  });

  it("uses system role when configured", () => {
    const msgs = [msg("user", "old"), msg("user", "new")];
    const result: CompactionResult = {
      summary: "s",
      tokensSaved: 10,
      summarizedCount: 1,
      firstKeptIndex: 1,
    };
    const cfg: CompactionConfig = {
      ...compactionConfigSchema.parse({}),
      summaryRole: "system",
    };
    const applied = applyCompaction(msgs, result, cfg);
    expect(applied[0].role).toBe("system");
  });

  it("omits prefix when summaryPrefix is empty", () => {
    const msgs = [msg("user", "old"), msg("user", "new")];
    const result: CompactionResult = {
      summary: "plain summary",
      tokensSaved: 10,
      summarizedCount: 1,
      firstKeptIndex: 1,
    };
    const cfg: CompactionConfig = {
      ...compactionConfigSchema.parse({}),
      summaryPrefix: "",
    };
    const applied = applyCompaction(msgs, result, cfg);
    expect(applied[0].content).toBe("plain summary");
  });
});
