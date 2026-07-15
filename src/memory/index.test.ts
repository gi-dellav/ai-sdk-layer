import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Mem } from "./store.js";
import { contextBlock } from "./context.js";
import { search, SearchResults } from "./search.js";
import { createMemoryTools } from "./tools/index.js";
import { effectiveReserve, getContextBlock } from "./integration.js";
import { createMemoryStore } from "./index.js";
import {
  MemoryConfigSchema,
  memoryWriteInputSchema,
  memoryEditInputSchema,
  memoryReadInputSchema,
  memorySearchInputSchema,
} from "./types.js";

const testDir = path.join(os.tmpdir(), "ai-sdk-memory-tests");

function setup(): string {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
  return testDir;
}

function cleanup() {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

// ============================================================
// MemoryConfigSchema
// ============================================================
describe("MemoryConfigSchema", () => {
  it("fills defaults", () => {
    const c = MemoryConfigSchema.parse({});
    expect(c.maxInjectBytes).toBe(32 * 1024);
    expect(c.maxWriteBytes).toBe(64 * 1024);
    expect(c.maxSearchBytes).toBe(32 * 1024);
    expect(c.baseDir).toBeUndefined();
  });

  it("accepts overrides", () => {
    const c = MemoryConfigSchema.parse({ baseDir: "/tmp/mem", maxWriteBytes: 999 });
    expect(c.baseDir).toBe("/tmp/mem");
    expect(c.maxWriteBytes).toBe(999);
  });
});

// ============================================================
// Tool input schemas
// ============================================================
describe("memoryWriteInputSchema", () => {
  it("parses valid input", () => {
    const i = memoryWriteInputSchema.parse({ target: "long_term", content: "hello" });
    expect(i.target).toBe("long_term");
    expect(i.mode).toBe("append");
  });

  it("rejects invalid target", () => {
    expect(() => memoryWriteInputSchema.parse({ target: "invalid", content: "x" }))
      .toThrow();
  });
});

describe("memoryEditInputSchema", () => {
  it("parses valid input", () => {
    const i = memoryEditInputSchema.parse({ target: "long_term", old_str: "a", new_str: "b" });
    expect(i.new_str).toBe("b");
  });

  it("defaults new_str to empty", () => {
    const i = memoryEditInputSchema.parse({ target: "long_term", old_str: "a" });
    expect(i.new_str).toBe("");
  });
});

describe("memoryReadInputSchema", () => {
  it("parses valid input", () => {
    const i = memoryReadInputSchema.parse({ source: "long_term" });
    expect(i.source).toBe("long_term");
  });
});

describe("memorySearchInputSchema", () => {
  it("parses valid input", () => {
    const i = memorySearchInputSchema.parse({ query: "hello world" });
    expect(i.query).toBe("hello world");
  });
});

// ============================================================
// Mem class
// ============================================================
describe("Mem", () => {
  let mem: Mem;

  beforeEach(() => {
    const baseDir = setup();
    mem = new Mem({ baseDir });
  });

  afterEach(cleanup);

  it("creates with custom baseDir", () => {
    expect(mem.root).toBe(testDir);
    expect(mem.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("longTermPath returns MEMORY.md at root", () => {
    expect(mem.longTermPath()).toBe(path.join(testDir, "MEMORY.md"));
  });

  it("scratchpadPath includes project slug", () => {
    const p = mem.scratchpadPath();
    expect(p).toContain("projects");
    expect(p).toContain("SCRATCHPAD.md");
  });

  it("dailyPath validates date format", () => {
    expect(mem.isSafeDailyName("2024-01-01")).toBe(true);
    expect(mem.isSafeDailyName("../../etc/passwd")).toBe(false);
    expect(mem.isSafeDailyName("")).toBe(false);
  });

  it("notePath sanitizes name", () => {
    const p = mem.notePath("my/../../../secret");
    expect(p).not.toContain("..");
    expect(p).toContain("notes");
  });

  it("read returns null for missing file", async () => {
    const content = await mem.read("/nonexistent/file.md");
    expect(content).toBeNull();
  });

  it("read returns content for existing file", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "hello world");
    const content = await mem.read(mem.longTermPath());
    expect(content).toBe("hello world");
  });

  it("write long_term append with dedup skips duplicates", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "First fact\n");
    const result1 = await mem.write(
      mem.longTermPath(),
      "First fact\nSecond fact\n",
      "append",
      "long_term",
    );
    expect(result1).toContain("MEMORY.md");
    const content = await mem.read(mem.longTermPath());
    expect(content).toContain("First fact");
    expect(content).toContain("Second fact");
    expect(content).toContain("duplicate");
    const lines = content!.split("\n").filter((l) => l === "First fact");
    expect(lines.length).toBe(1);
  });

  it("write long_term overwrite replaces file", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "old");
    await mem.write(mem.longTermPath(), "new", "overwrite", "long_term");
    const content = await mem.read(mem.longTermPath());
    expect(content!.trim()).toBe("new");
  });

  it("write scratchpad append adds content", async () => {
    fs.mkdirSync(path.dirname(mem.scratchpadPath()), { recursive: true });
    fs.writeFileSync(mem.scratchpadPath(), "- [ ] task1\n");
    await mem.write(mem.scratchpadPath(), "- [ ] task2\n", "append", "scratchpad");
    const content = await mem.read(mem.scratchpadPath());
    expect(content).toContain("task1");
    expect(content).toContain("task2");
  });

  it("write daily forces append mode", async () => {
    const result = await mem.write(mem.todayPath(), "entry\n", "overwrite" as never, "daily");
    const content = await mem.read(mem.todayPath());
    expect(content).toContain("entry");
  });

  it("listDailyFiles returns sorted dates", async () => {
    fs.mkdirSync(path.dirname(mem.dailyPath("2024-01-01")), { recursive: true });
    fs.writeFileSync(mem.dailyPath("2024-01-01"), "a");
    fs.writeFileSync(mem.dailyPath("2024-01-02"), "b");
    const dailies = await mem.listDailyFiles();
    expect(dailies[0]).toBe("2024-01-02");
    expect(dailies[1]).toBe("2024-01-01");
  });

  it("listNotes returns note names", async () => {
    const np = mem.notePath("test-note");
    fs.mkdirSync(path.dirname(np), { recursive: true });
    fs.writeFileSync(np, "content");
    const notes = await mem.listNotes();
    expect(notes).toContain("test-note");
  });

  it("collectMdFiles finds all .md files", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "global");
    fs.mkdirSync(path.dirname(mem.notePath("n1")), { recursive: true });
    fs.writeFileSync(mem.notePath("n1"), "note");
    fs.mkdirSync(path.dirname(mem.dailyPath("2024-06-01")), { recursive: true });
    fs.writeFileSync(mem.dailyPath("2024-06-01"), "daily");

    const files = await mem.collectMdFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("appendDaily adds timestamped entry", async () => {
    await mem.appendDaily("test heading", "body text");
    const content = await mem.read(mem.todayPath());
    expect(content).toContain("### ");
    expect(content).toContain("test heading");
    expect(content).toContain("body text");
  });

  it("backup created before overwrite long_term", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "original");
    await mem.write(mem.longTermPath(), "replaced", "overwrite", "long_term");
    const bakPath = mem.longTermPath().replace(/\.md$/, ".bak");
    expect(fs.existsSync(bakPath)).toBe(true);
    expect(fs.readFileSync(bakPath, "utf-8")).toBe("original");
  });
});

// ============================================================
// Context block
// ============================================================
describe("contextBlock", () => {
  let mem: Mem;

  beforeEach(() => {
    const baseDir = setup();
    mem = new Mem({ baseDir, maxInjectBytes: 32 * 1024 });
  });

  afterEach(cleanup);

  it("returns null when no memory exists", async () => {
    const block = await contextBlock(mem);
    expect(block).toBeNull();
  });

  it("includes scratchpad open items", async () => {
    fs.mkdirSync(path.dirname(mem.scratchpadPath()), { recursive: true });
    fs.writeFileSync(mem.scratchpadPath(), "- [ ] task1\n- [x] done\n  - [ ] task2\n");
    const block = await contextBlock(mem);
    expect(block).toContain("task1");
    expect(block).toContain("task2");
    expect(block).not.toContain("[x]");
  });

  it("includes long-term memory", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "LTM content");
    const block = await contextBlock(mem);
    expect(block).toContain("LTM content");
  });

  it("includes recent daily logs", async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    fs.mkdirSync(path.dirname(mem.dailyPath(yesterday)), { recursive: true });
    fs.writeFileSync(mem.dailyPath(yesterday), "yesterday log");
    const block = await contextBlock(mem);
    expect(block).toContain("yesterday log");
  });

  it("wraps in memory XML tag", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "data");
    const block = await contextBlock(mem);
    expect(block).toContain("<memory");
    expect(block).toContain("Reference only");
    expect(block).toContain("</memory>");
  });

  it("truncates when budget exceeded", async () => {
    mem = new Mem({ baseDir: mem.root, maxInjectBytes: 10 });
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "A".repeat(200));
    const block = await contextBlock(mem);
    expect(block).toContain("[section truncated]");
  });
});

// ============================================================
// Search
// ============================================================
describe("search", () => {
  let mem: Mem;

  beforeEach(() => {
    const baseDir = setup();
    mem = new Mem({ baseDir });
  });

  afterEach(cleanup);

  it("finds matches in long-term memory", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "The quick brown fox\njumps over the lazy dog");
    const results = await search(mem, "fox");
    expect(results.hits.length).toBe(1);
  });

  it("returns empty for no matches", async () => {
    const results = await search(mem, "nonexistent");
    expect(results.hits.length).toBe(0);
  });

  it("matches case-insensitively", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "Hello World");
    const results = await search(mem, "hello");
    expect(results.hits.length).toBe(1);
  });

  it("ranks MEMORY.md hits first", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "keyword here");
    fs.mkdirSync(path.dirname(mem.notePath("test")), { recursive: true });
    fs.writeFileSync(mem.notePath("test"), "keyword here too");
    const results = await search(mem, "keyword");
    const ranked = results.rankedHits();
    expect(ranked[0].path).toContain("MEMORY.md");
  });

  it("render produces formatted output", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "match");
    const results = await search(mem, "match");
    const output = results.render(4096);
    expect(output).toContain("MEMORY.md");
    expect(output).toContain("match");
  });

  it("render returns 'No matches' for empty", () => {
    const results = new SearchResults([], {});
    expect(results.render(100)).toBe("No matches found.");
  });
});

// ============================================================
// Tools
// ============================================================
describe("createMemoryTools", () => {
  let mem: Mem;

  beforeEach(() => {
    const baseDir = setup();
    mem = new Mem({ baseDir });
  });

  afterEach(cleanup);

  it("returns full toolset by default", () => {
    const tools = createMemoryTools({ mem });
    expect(tools).toHaveProperty("memory_read");
    expect(tools).toHaveProperty("memory_search");
    expect(tools).toHaveProperty("memory_write");
    expect(tools).toHaveProperty("memory_edit");
  });

  it("returns read-only toolset when readOnly=true", () => {
    const tools = createMemoryTools({ mem, readOnly: true });
    expect(tools).toHaveProperty("memory_read");
    expect(tools).toHaveProperty("memory_search");
    expect(tools).not.toHaveProperty("memory_write");
    expect(tools).not.toHaveProperty("memory_edit");
  });

  it("memory_write tool appends to long_term", async () => {
    const tools = createMemoryTools({ mem });
    const result = await tools["memory_write"].execute(
      { target: "long_term", content: "test fact", mode: "append" },
    );
    expect(result).toContain("MEMORY.md");
    const content = await mem.read(mem.longTermPath());
    expect(content).toContain("test fact");
  });

  it("memory_write requires name for note target", async () => {
    const tools = createMemoryTools({ mem });
    const result = await tools["memory_write"].execute(
      { target: "note", content: "note content", mode: "append" },
    );
    expect(result).toContain("Error");
  });

  it("memory_read returns empty for missing file", async () => {
    const tools = createMemoryTools({ mem });
    const result = await tools["memory_read"].execute({ source: "long_term" });
    expect(result).toBe("(empty)");
  });

  it("memory_read lists notes and dailies", async () => {
    const tools = createMemoryTools({ mem });
    const result = await tools["memory_read"].execute({ source: "list" });
    expect(result).toContain("Notes");
    expect(result).toContain("Daily Logs");
  });

  it("memory_search returns results", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "find me");
    const tools = createMemoryTools({ mem });
    const result = await tools["memory_search"].execute({ query: "find" });
    expect(result).toContain("find");
  });

  it("memory_edit replaces unique substring", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "hello world");
    const tools = createMemoryTools({ mem });
    const result = await tools["memory_edit"].execute({
      target: "long_term",
      old_str: "world",
      new_str: "there",
    });
    expect(result).toContain("Replaced");
    const content = await mem.read(mem.longTermPath());
    expect(content).toContain("hello there");
  });

  it("memory_edit rejects non-unique old_str", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "the the");
    const tools = createMemoryTools({ mem });
    const result = await tools["memory_edit"].execute({
      target: "long_term",
      old_str: "the",
      new_str: "a",
    });
    expect(result).toContain("multiple");
  });

  it("memory_edit deletes note when old_str is empty", async () => {
    const np = mem.notePath("delnote");
    fs.mkdirSync(path.dirname(np), { recursive: true });
    fs.writeFileSync(np, "content");
    const tools = createMemoryTools({ mem });
    const result = await tools["memory_edit"].execute({
      target: "note",
      name: "delnote",
    });
    expect(result).toContain("Deleted");
    expect(fs.existsSync(np)).toBe(false);
  });
});

// ============================================================
// Integration helpers
// ============================================================
describe("integration", () => {
  let mem: Mem;

  beforeEach(() => {
    const baseDir = setup();
    mem = new Mem({ baseDir });
  });

  afterEach(cleanup);

  it("effectiveReserve returns estimated tokens", () => {
    const reserve = effectiveReserve(mem);
    expect(reserve).toBeGreaterThan(0);
  });

  it("getContextBlock returns null when empty", async () => {
    const block = await getContextBlock(mem);
    expect(block).toBeNull();
  });

  it("getContextBlock returns content when memory exists", async () => {
    fs.mkdirSync(path.dirname(mem.longTermPath()), { recursive: true });
    fs.writeFileSync(mem.longTermPath(), "data");
    const block = await getContextBlock(mem);
    expect(block).toContain("data");
  });
});

// ============================================================
// MemoryStore (simple key-value)
// ============================================================
describe("createMemoryStore", () => {
  it("stores and retrieves values", async () => {
    const store = createMemoryStore();
    await store.store("key1", { a: 1 });
    const val = await store.retrieve("key1");
    expect(val).toEqual({ a: 1 });
  });

  it("returns null for missing key", async () => {
    const store = createMemoryStore();
    const val = await store.retrieve("missing");
    expect(val).toBeNull();
  });

  it("forgets keys", async () => {
    const store = createMemoryStore();
    await store.store("k", "v");
    await store.forget("k");
    expect(await store.retrieve("k")).toBeNull();
  });

  it("clears all keys", async () => {
    const store = createMemoryStore();
    await store.store("a", 1);
    await store.store("b", 2);
    await store.clear();
    expect(await store.retrieve("a")).toBeNull();
    expect(await store.retrieve("b")).toBeNull();
  });

  it("search returns all entries", async () => {
    const store = createMemoryStore();
    await store.store("a", 1);
    await store.store("b", 2);
    const results = await store.search("");
    expect(results.length).toBe(2);
  });
});
