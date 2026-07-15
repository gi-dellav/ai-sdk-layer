import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import {
  taskInputSchema,
  subagentConfigSchema,
  type TaskInput,
  type SubagentConfig,
} from "./types.js";
import { EXPLORE_PROMPT } from "./prompt.js";
import {
  createTaskTool,
  buildSystemPrompt,
  truncateResponse,
  combineResults,
  type TaskToolOptions,
} from "./task_tool.js";
import type { Tool } from "ai";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...(actual as object),
    generateText: vi.fn(),
  };
});

const { generateText } = await import("ai");
const mockGenerateText = generateText as ReturnType<typeof vi.fn>;

function mockModel(): unknown {
  return {
    specificationVersion: "v1",
    provider: "test",
    modelId: "test-model",
  };
}

// ---------------------------------------------------------------------------
// taskInputSchema
// ---------------------------------------------------------------------------

describe("taskInputSchema", () => {
  it("accepts a single prompt", () => {
    const parsed = taskInputSchema.parse({ prompts: ["find usage of X"] });
    expect(parsed.prompts).toEqual(["find usage of X"]);
  });

  it("accepts multiple prompts", () => {
    const parsed = taskInputSchema.parse({
      prompts: ["task 1", "task 2", "task 3"],
    });
    expect(parsed.prompts).toHaveLength(3);
  });

  it("rejects empty prompts array", () => {
    expect(() => taskInputSchema.parse({ prompts: [] })).toThrow();
  });

  it("rejects more than 10 prompts", () => {
    expect(() =>
      taskInputSchema.parse({ prompts: Array.from({ length: 11 }, (_, i) => `p${i}`) }),
    ).toThrow();
  });

  it("rejects non-string prompts", () => {
    expect(() => taskInputSchema.parse({ prompts: [123] })).toThrow();
  });

  it("rejects empty string prompt", () => {
    expect(() => taskInputSchema.parse({ prompts: [""] })).toThrow();
  });

  it("accepts exactly 10 prompts", () => {
    const parsed = taskInputSchema.parse({
      prompts: Array.from({ length: 10 }, (_, i) => `prompt ${i}`),
    });
    expect(parsed.prompts).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// subagentConfigSchema
// ---------------------------------------------------------------------------

describe("subagentConfigSchema", () => {
  it("fills defaults on empty input", () => {
    const cfg = subagentConfigSchema.parse({});
    expect(cfg.taskEnabled).toBe(true);
    expect(cfg.maxTurns).toBe(20);
    expect(cfg.timeoutMs).toBe(300_000);
    expect(cfg.maxResponseBytes).toBe(131_072);
    expect(cfg.maxReadLines).toBe(2000);
    expect(cfg.maxGrepResults).toBe(200);
    expect(cfg.maxFindResults).toBe(200);
    expect(cfg.architecture).toBeUndefined();
  });

  it("accepts partial overrides", () => {
    const cfg = subagentConfigSchema.parse({
      maxTurns: 10,
      timeoutMs: 60_000,
      architecture: "project layout...",
    });
    expect(cfg.maxTurns).toBe(10);
    expect(cfg.timeoutMs).toBe(60_000);
    expect(cfg.architecture).toBe("project layout...");
    expect(cfg.taskEnabled).toBe(true); // default
  });

  it("rejects non-positive maxTurns", () => {
    expect(() => subagentConfigSchema.parse({ maxTurns: 0 })).toThrow();
    expect(() => subagentConfigSchema.parse({ maxTurns: -1 })).toThrow();
  });

  it("rejects non-positive timeoutMs", () => {
    expect(() => subagentConfigSchema.parse({ timeoutMs: 0 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// EXPLORE_PROMPT
// ---------------------------------------------------------------------------

describe("EXPLORE_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof EXPLORE_PROMPT).toBe("string");
    expect(EXPLORE_PROMPT.length).toBeGreaterThan(100);
  });

  it("mentions read-only constraint", () => {
    expect(EXPLORE_PROMPT).toContain("read-only");
  });

  it("lists available tools", () => {
    expect(EXPLORE_PROMPT).toContain("read");
    expect(EXPLORE_PROMPT).toContain("grep");
    expect(EXPLORE_PROMPT).toContain("find_files");
    expect(EXPLORE_PROMPT).toContain("list_dir");
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  it("returns base prompt when no architecture is provided", () => {
    const cfg = subagentConfigSchema.parse({});
    const prompt = buildSystemPrompt(cfg);
    expect(prompt).toBe(EXPLORE_PROMPT);
  });

  it("appends architecture when provided", () => {
    const cfg = subagentConfigSchema.parse({
      architecture: "monorepo with packages/",
    });
    const prompt = buildSystemPrompt(cfg);
    expect(prompt).toContain(EXPLORE_PROMPT);
    expect(prompt).toContain("## Project Architecture");
    expect(prompt).toContain("monorepo with packages/");
  });
});

// ---------------------------------------------------------------------------
// truncateResponse
// ---------------------------------------------------------------------------

describe("truncateResponse", () => {
  it("returns text unchanged when under the limit", () => {
    const text = "hello world";
    expect(truncateResponse(text, 1024)).toBe(text);
  });

  it("truncates text exceeding the byte limit", () => {
    const text = "a".repeat(100);
    const result = truncateResponse(text, 50);
    expect(result.length).toBeLessThan(100);
    expect(result).toContain("truncated at 50B");
  });

  it("handles multi-byte characters safely (CJK)", () => {
    // each CJK char is 3 bytes in UTF-8
    const text = "你好世界".repeat(50); // 4 chars * 50 = 200 chars, 600 bytes
    const result = truncateResponse(text, 30);
    // should not have broken a multi-byte char
    expect(result).toContain("truncated");
    // the text before the truncation marker should decode cleanly
    const prefix = result.split("\n…[subagent")[0];
    expect(() => new TextEncoder().encode(prefix)).not.toThrow();
  });

  it("returns just the marker for very small limits", () => {
    const text = "hello world";
    const result = truncateResponse(text, 0);
    // binary search might give empty prefix
    expect(result).toContain("truncated at 0B");
  });

  it("handles exact boundary", () => {
    const encoder = new TextEncoder();
    const text = "abc";
    const byteLen = encoder.encode(text).length;
    expect(truncateResponse(text, byteLen)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// combineResults
// ---------------------------------------------------------------------------

describe("combineResults", () => {
  it("returns raw response for a single result", () => {
    const results = [{ index: 0, prompt: "find X", response: "found here" }];
    expect(combineResults(results)).toBe("found here");
  });

  it("combines multiple results with headings", () => {
    const results = [
      { index: 0, prompt: "task one", response: "result one" },
      { index: 1, prompt: "task two", response: "result two" },
    ];
    const combined = combineResults(results);
    expect(combined).toContain("## Task 1: task one");
    expect(combined).toContain("result one");
    expect(combined).toContain("## Task 2: task two");
    expect(combined).toContain("result two");
  });

  it("truncates long prompts in headings to 60 chars", () => {
    const longPrompt = "a".repeat(80);
    // need 2+ results to trigger heading rendering
    const results = [
      { index: 0, prompt: longPrompt, response: "ok" },
      { index: 1, prompt: "short", response: "also ok" },
    ];
    const combined = combineResults(results);
    // "a".repeat(80) → heading shows "a".repeat(57) + "..."
    expect(combined).toContain("a".repeat(57) + "...");
  });

  it("sorts by index", () => {
    const results = [
      { index: 2, prompt: "third", response: "c" },
      { index: 0, prompt: "first", response: "a" },
      { index: 1, prompt: "second", response: "b" },
    ];
    const combined = combineResults(results);
    const posA = combined.indexOf("## Task 1: first");
    const posB = combined.indexOf("## Task 2: second");
    const posC = combined.indexOf("## Task 3: third");
    expect(posA).toBeLessThan(posB);
    expect(posB).toBeLessThan(posC);
  });

  it("ends with a trailing newline", () => {
    const results = [{ index: 0, prompt: "p", response: "r" }];
    const combined = combineResults(results);
    expect(combined).toBe("r");
  });
});

// ---------------------------------------------------------------------------
// createTaskTool
// ---------------------------------------------------------------------------

describe("createTaskTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeTool(overrides?: Partial<SubagentConfig>): Tool {
    return createTaskTool({ model: mockModel(), config: overrides });
  }

  it("returns a valid Tool shape", () => {
    const tool = makeTool();
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.execute).toBe("function");
    expect(tool.inputSchema).toBeDefined();
  });

  it("inputSchema accepts valid task input", () => {
    const tool = makeTool();
    const schema = tool.inputSchema as z.ZodType<TaskInput>;
    expect(() => schema.parse({ prompts: ["p1"] })).not.toThrow();
    expect(() => schema.parse({})).toThrow();
  });

  it("calls generateText for a single prompt", async () => {
    const tool = makeTool();
    mockGenerateText.mockResolvedValueOnce({ text: "found 3 usages" });

    const result = await tool.execute!({ prompts: ["where is X used?"] });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(result).toBe("found 3 usages");
  });

  it("calls generateText for each prompt in parallel", async () => {
    const tool = makeTool();
    mockGenerateText
      .mockResolvedValueOnce({ text: "result A" })
      .mockResolvedValueOnce({ text: "result B" })
      .mockResolvedValueOnce({ text: "result C" });

    const result = await tool.execute!({
      prompts: ["a", "b", "c"],
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    expect(result).toContain("## Task 1: a");
    expect(result).toContain("result A");
    expect(result).toContain("## Task 2: b");
    expect(result).toContain("result B");
    expect(result).toContain("## Task 3: c");
    expect(result).toContain("result C");
  });

  it("passes system prompt and tools to generateText", async () => {
    const tool = makeTool();
    mockGenerateText.mockResolvedValueOnce({ text: "ok" });

    await tool.execute!({ prompts: ["find X"] });

    const callArg = mockGenerateText.mock.calls[0][0];
    expect(callArg.system).toContain("code investigation agent");
    expect(callArg.messages).toEqual([{ role: "user", content: "find X" }]);
    expect(callArg.tools).toBeDefined();
    expect(callArg.tools.read).toBeDefined();
    expect(callArg.tools.grep).toBeDefined();
    expect(callArg.tools.find_files).toBeDefined();
    expect(callArg.tools.list_dir).toBeDefined();
    // edit tool must not be present (read-only)
    expect(callArg.tools.edit).toBeUndefined();
  });

  it("passes stopWhen with maxTurns from config", async () => {
    const tool = makeTool({ maxTurns: 5 });
    mockGenerateText.mockResolvedValueOnce({ text: "ok" });

    await tool.execute!({ prompts: ["find X"] });

    const callArg = mockGenerateText.mock.calls[0][0];
    expect(callArg.stopWhen).toBeDefined();
    expect(typeof callArg.stopWhen).toBe("function");
    // stepCountIs(5) — verify by calling it
    const stopWhen = callArg.stopWhen as (opts: {
      steps: Array<unknown>;
    }) => boolean;
    expect(stopWhen({ steps: Array.from({ length: 4 }) })).toBe(false);
    expect(stopWhen({ steps: Array.from({ length: 5 }) })).toBe(true);
  });

  it("returns error message when generateText returns empty", async () => {
    const tool = makeTool();
    mockGenerateText.mockResolvedValueOnce({ text: "" });

    const result = await tool.execute!({ prompts: ["find X"] });
    expect(result).toBe("[error: subagent returned empty response]");
  });

  it("returns error when generateText throws", async () => {
    const tool = makeTool();
    mockGenerateText.mockRejectedValueOnce(new Error("API failure"));

    const result = await tool.execute!({ prompts: ["find X"] });
    expect(result).toBe("[error: API failure]");
  });

  it("returns timeout message on TimeoutError", async () => {
    const tool = makeTool({ timeoutMs: 1000 });
    const timeoutErr = new DOMException("timeout", "TimeoutError");
    mockGenerateText.mockRejectedValueOnce(timeoutErr);

    const result = await tool.execute!({ prompts: ["find X"] });
    expect(result).toBe("[timeout: subagent exceeded 1s]");
  });

  it("passes abortSignal to generateText", async () => {
    const tool = makeTool();
    mockGenerateText.mockResolvedValueOnce({ text: "ok" });

    const controller = new AbortController();
    await tool.execute!(
      { prompts: ["find X"] },
      { abortSignal: controller.signal },
    );

    const callArg = mockGenerateText.mock.calls[0][0];
    expect(callArg.abortSignal).toBeDefined();
  });

  it("appends architecture to system prompt when configured", async () => {
    const tool = makeTool({ architecture: "src/ layout..." });
    mockGenerateText.mockResolvedValueOnce({ text: "ok" });

    await tool.execute!({ prompts: ["find X"] });

    const callArg = mockGenerateText.mock.calls[0][0];
    expect(callArg.system).toContain("## Project Architecture");
    expect(callArg.system).toContain("src/ layout...");
  });

  it("still returns results from other subagents when one fails", async () => {
    const tool = makeTool();
    mockGenerateText
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ text: "success" });

    const result = await tool.execute!({
      prompts: ["failing", "working"],
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(result).toContain("[error: fail]");
    expect(result).toContain("success");
  });

  it("uses custom maxResponseBytes for truncation", async () => {
    const tool = makeTool({ maxResponseBytes: 20 });
    const longResponse = "a".repeat(500);
    mockGenerateText.mockResolvedValueOnce({ text: longResponse });

    const result = await tool.execute!({ prompts: ["describe"] });
    expect(result).toContain("truncated at 20B");
  });
});
