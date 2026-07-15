import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import {
  advisorConfigSchema,
  type AdvisorConfig,
} from "./types.js";
import { formatConversation } from "./format-conversation.js";
import { createAdvisor } from "./advisor-tool.js";
import type { ModelMessage } from "ai";

function msg(role: string, content: string): ModelMessage {
  return { role, content } as ModelMessage;
}

// ---------------------------------------------------------------------------
// advisorConfigSchema
// ---------------------------------------------------------------------------
describe("advisorConfigSchema", () => {
  it("fills defaults on empty input", () => {
    const cfg = advisorConfigSchema.parse({});
    expect(cfg.contextLimit).toBe(256);
    expect(cfg.systemPrompt).toBeUndefined();
    expect(cfg.maxUses).toBeUndefined();
    expect(cfg.description).toBeUndefined();
  });

  it("accepts partial overrides", () => {
    const cfg = advisorConfigSchema.parse({
      maxUses: 5,
      contextLimit: 512,
      description: "custom desc",
    });
    expect(cfg.maxUses).toBe(5);
    expect(cfg.contextLimit).toBe(512);
    expect(cfg.description).toBe("custom desc");
  });

  it("rejects non-positive maxUses", () => {
    expect(() => advisorConfigSchema.parse({ maxUses: 0 })).toThrow();
    expect(() => advisorConfigSchema.parse({ maxUses: -1 })).toThrow();
  });

  it("rejects non-positive contextLimit", () => {
    expect(() => advisorConfigSchema.parse({ contextLimit: 0 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatConversation
// ---------------------------------------------------------------------------
describe("formatConversation", () => {
  it("returns empty string for empty messages", () => {
    expect(formatConversation([], 256)).toBe("");
  });

  it("returns all messages when they fit within budget", () => {
    const msgs = [msg("user", "hello"), msg("assistant", "hi there")];
    const result = formatConversation(msgs, 256);
    expect(result).toContain("[User]: hello");
    expect(result).toContain("[Assistant]: hi there");
  });

  it("truncates with head + tail when budget is tight", () => {
    const msgs: ModelMessage[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push(msg("user", `message number ${i} with some content to fill space`));
    }
    const result = formatConversation(msgs, 2); // 2 KB = tiny budget
    expect(result).toContain("[User]: message number 0");
    expect(result).toContain("messages omitted");
    expect(result).toContain("[User]: message number 49");
  });

  it("handles a single message", () => {
    const msgs = [msg("system", "you are helpful")];
    const result = formatConversation(msgs, 256);
    expect(result).toBe("[System]: you are helpful");
  });

  it("capitalizes role names", () => {
    const msgs = [msg("tool", "tool output"), msg("assistant", "reply")];
    const result = formatConversation(msgs, 256);
    expect(result).toContain("[Tool]: tool output");
    expect(result).toContain("[Assistant]: reply");
  });

  it("handles array content in messages", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "part one" },
          { type: "text", text: "part two" },
        ],
      } as ModelMessage,
    ];
    const result = formatConversation(msgs, 256);
    expect(result).toBe("[Assistant]: part one\npart two");
  });

  it("handles very small budget (1 byte)", () => {
    const msgs: ModelMessage[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(msg("user", "fairly long message content here"));
    }
    // 1 byte budget: nothing fits in head or tail except maybe if
    // a message is somehow 1 byte. This should show all omitted.
    const result = formatConversation(msgs, 0);
    // 0 KB = 0 bytes, nothing fits
    expect(result).toContain("messages omitted");
  });

  it("handles all messages fitting in head only", () => {
    const msgs = [msg("user", "a"), msg("assistant", "b")];
    // Huge budget: all fits in head, no tail needed
    const result = formatConversation(msgs, 1024);
    expect(result).not.toContain("omitted");
    expect(result).toContain("[User]: a");
    expect(result).toContain("[Assistant]: b");
  });
});

// ---------------------------------------------------------------------------
// createAdvisor
// ---------------------------------------------------------------------------

// Mock generateText so we don't need real models
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...(actual as object),
    generateText: vi.fn(),
  };
});

const { generateText } = await import("ai");
const mockGenerateText = generateText as ReturnType<typeof vi.fn>;

function mockModel(): import("ai").LanguageModel {
  return {
    specificationVersion: "v1",
    provider: "test",
    modelId: "test-model",
  } as import("ai").LanguageModel;
}

describe("createAdvisor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when model is missing", () => {
    expect(() => createAdvisor(null as unknown as import("ai").LanguageModel)).toThrow(
      "advisor requires a LanguageModel",
    );
  });

  it("returns an object with tool, usageCount, and resetUsage", () => {
    const inst = createAdvisor(mockModel());
    expect(inst.tool).toBeDefined();
    expect(inst.tool.description).toBeDefined();
    expect(inst.tool.inputSchema).toBeDefined();
    expect(inst.tool.execute).toBeDefined();
    expect(inst.usageCount).toBe(0);
    expect(typeof inst.resetUsage).toBe("function");
  });

  it("uses custom description when provided", () => {
    const inst = createAdvisor(mockModel(), { description: "custom" });
    expect(inst.tool.description).toBe("custom");
  });

  it("uses custom system prompt", async () => {
    const inst = createAdvisor(mockModel(), { systemPrompt: "be terse" });

    mockGenerateText.mockResolvedValueOnce({ text: "advice" });

    await inst.tool.execute!(
      { question: "q" },
      { messages: [] },
    );

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ system: "be terse" }),
    );
  });

  it("enforces maxUses limit", async () => {
    const inst = createAdvisor(mockModel(), { maxUses: 2 });

    mockGenerateText.mockResolvedValue({ text: "advice" });

    await inst.tool.execute!({ question: "q1" }, { messages: [] });
    await inst.tool.execute!({ question: "q2" }, { messages: [] });

    const result = await inst.tool.execute!(
      { question: "q3" },
      { messages: [] },
    );

    expect(result).toBe("[Advisor unavailable: maximum uses (2) reached]");
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it("increments usageCount", async () => {
    const inst = createAdvisor(mockModel());

    mockGenerateText.mockResolvedValue({ text: "advice" });

    expect(inst.usageCount).toBe(0);
    await inst.tool.execute!({ question: "q" }, { messages: [] });
    expect(inst.usageCount).toBe(1);
    await inst.tool.execute!({ question: "q2" }, { messages: [] });
    expect(inst.usageCount).toBe(2);
  });

  it("resetUsage resets counter", async () => {
    const inst = createAdvisor(mockModel());

    mockGenerateText.mockResolvedValue({ text: "advice" });

    await inst.tool.execute!({ question: "q" }, { messages: [] });
    expect(inst.usageCount).toBe(1);
    inst.resetUsage();
    expect(inst.usageCount).toBe(0);
  });

  it("calls generateText with the advisor model", async () => {
    const model = mockModel();
    const inst = createAdvisor(model);

    mockGenerateText.mockResolvedValueOnce({ text: "do X then Y" });

    const result = await inst.tool.execute!(
      { question: "how to fix the bug?" },
      { messages: [] },
    );

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ model }),
    );
    expect(result).toBe("do X then Y");
  });

  it("returns empty response message when result is empty", async () => {
    const inst = createAdvisor(mockModel());

    mockGenerateText.mockResolvedValueOnce({ text: "" });

    const result = await inst.tool.execute!(
      { question: "q" },
      { messages: [] },
    );

    expect(result).toBe("[Advisor returned empty response]");
  });

  it("returns empty response message when result is whitespace only", async () => {
    const inst = createAdvisor(mockModel());

    mockGenerateText.mockResolvedValueOnce({ text: "   " });

    const result = await inst.tool.execute!(
      { question: "q" },
      { messages: [] },
    );

    expect(result).toBe("[Advisor returned empty response]");
  });

  it("handles generateText errors gracefully", async () => {
    const inst = createAdvisor(mockModel());

    mockGenerateText.mockRejectedValueOnce(new Error("API error"));

    const result = await inst.tool.execute!(
      { question: "q" },
      { messages: [] },
    );

    expect(result).toBe("[Advisor error: API error]");
  });

  it("handles abort signals", async () => {
    const inst = createAdvisor(mockModel());

    const abortError = new Error("aborted") as Error & { name: string };
    abortError.name = "AbortError";
    mockGenerateText.mockRejectedValueOnce(abortError);

    const controller = new AbortController();
    const result = await inst.tool.execute!(
      { question: "q" },
      { messages: [], abortSignal: controller.signal },
    );

    expect(result).toBe("[Advisor call was aborted]");
  });

  it("passes abortSignal to generateText", async () => {
    const inst = createAdvisor(mockModel());

    mockGenerateText.mockResolvedValueOnce({ text: "ok" });

    const controller = new AbortController();
    await inst.tool.execute!(
      { question: "q" },
      { messages: [], abortSignal: controller.signal },
    );

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal }),
    );
  });

  it("includes formatted conversation in the prompt", async () => {
    const inst = createAdvisor(mockModel(), { contextLimit: 1024 });

    mockGenerateText.mockResolvedValueOnce({ text: "advice" });

    const msgs = [
      msg("user", "initial request"),
      msg("assistant", "working on it"),
      msg("user", "new question here?"),
    ];

    await inst.tool.execute!(
      { question: "should I refactor?" },
      { messages: msgs },
    );

    const callArg = mockGenerateText.mock.calls[0][0];
    expect(callArg.prompt).toContain("## Conversation");
    expect(callArg.prompt).toContain("[User]: initial request");
    expect(callArg.prompt).toContain("[Assistant]: working on it");
    expect(callArg.prompt).toContain("## Question");
    expect(callArg.prompt).toContain("should I refactor?");
  });

  it("handles missing messages option gracefully", async () => {
    const inst = createAdvisor(mockModel());

    mockGenerateText.mockResolvedValueOnce({ text: "ok" });

    // no options at all
    await inst.tool.execute!({ question: "q" });

    const callArg = mockGenerateText.mock.calls[0][0];
    expect(callArg.prompt).toBe("## Question\nq");
  });

  it("validates inputSchema accepts question string", () => {
    const inst = createAdvisor(mockModel());
    const schema = inst.tool.inputSchema as z.ZodObject<{
      question: z.ZodString;
    }>;
    expect(() => schema.parse({ question: "test" })).not.toThrow();
    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ question: 123 })).toThrow();
  });

  it("returns Tool that matches Tool type contract", () => {
    const inst = createAdvisor(mockModel());
    expect(typeof inst.tool.description).toBe("string");
    expect(typeof inst.tool.execute).toBe("function");
    expect(inst.tool.inputSchema).toBeDefined();
  });
});
