import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileTools } from "./index.js";
import { fileToolsOptionsSchema } from "./types.js";
import {
  resolvePath,
  parseEditBlocks,
  applyEdits,
  whitespaceNormalize,
  levenshteinSimilarity,
  globToRegex,
  isBinaryFile,
  isSkipDir,
  findNewlineType,
  mergeContextWindows,
  limitedWireFormat,
  formatGrepOutput,
} from "./utils.js";
import type { FileToolsOptions } from "./types.js";

const fixturesDir = path.join(os.tmpdir(), "ai-sdk-file-tools-tests");

function setupFixture(): string {
  if (fs.existsSync(fixturesDir)) {
    fs.rmSync(fixturesDir, { recursive: true, force: true });
  }
  fs.mkdirSync(fixturesDir, { recursive: true });

  fs.writeFileSync(path.join(fixturesDir, "hello.txt"), "hello world\n");
  fs.writeFileSync(path.join(fixturesDir, "data.json"), '{"key": "value"}\n');
  fs.writeFileSync(path.join(fixturesDir, "src.ts"), 'const x = 1;\nfunction foo() {\n  return x;\n}\n');

  fs.mkdirSync(path.join(fixturesDir, "subdir"));
  fs.writeFileSync(path.join(fixturesDir, "subdir", "nested.txt"), "nested content\n");
  fs.writeFileSync(path.join(fixturesDir, "subdir", "nested.ts"), 'export const y = 2;\n');

  fs.mkdirSync(path.join(fixturesDir, "node_modules"));
  fs.writeFileSync(path.join(fixturesDir, "node_modules", "should-skip.txt"), "skipped\n");

  return fixturesDir;
}

function cleanupFixture() {
  if (fs.existsSync(fixturesDir)) {
    fs.rmSync(fixturesDir, { recursive: true, force: true });
  }
}

function opts(cwd: string): FileToolsOptions {
  return fileToolsOptionsSchema.parse({ cwd });
}

// ---- fileToolsOptionsSchema ----
describe("fileToolsOptionsSchema", () => {
  it("fills defaults", () => {
    const o = fileToolsOptionsSchema.parse({});
    expect(o.maxResults).toBe(200);
    expect(o.maxFileSize).toBe(10 * 1024 * 1024);
    expect(o.fuzzyThreshold).toBe(0.85);
    expect(o.skipDirs).toEqual(["node_modules", "target"]);
  });

  it("accepts overrides", () => {
    const o = fileToolsOptionsSchema.parse({ maxResults: 5, cwd: "/tmp" });
    expect(o.maxResults).toBe(5);
    expect(o.cwd).toBe("/tmp");
  });
});

// ---- resolvePath ----
describe("resolvePath", () => {
  it("resolves relative path against cwd", () => {
    const resolved = resolvePath("foo/bar", "/home/user");
    expect(resolved).toBe(path.normalize("/home/user/foo/bar"));
  });

  it("keeps absolute paths unchanged", () => {
    expect(resolvePath("/absolute/path", "/cwd")).toBe("/absolute/path");
  });

  it("normalizes paths", () => {
    expect(resolvePath("foo/./bar/..", "/cwd")).toBe(path.normalize("/cwd/foo"));
  });
});

// ---- parseEditBlocks ----
describe("parseEditBlocks", () => {
  it("parses a single SEARCH/REPLACE block", () => {
    const blocks = parseEditBlocks(
      "<<<<<<< SEARCH\nold text\n=======\nnew text\n>>>>>>> REPLACE"
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("old text");
    expect(blocks[0].replace).toBe("new text");
  });

  it("parses multiple blocks", () => {
    const blocks = parseEditBlocks(
      "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE"
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].search).toBe("a");
    expect(blocks[0].replace).toBe("b");
    expect(blocks[1].search).toBe("c");
    expect(blocks[1].replace).toBe("d");
  });

  it("parses multi-line search and replace", () => {
    const blocks = parseEditBlocks(
      "<<<<<<< SEARCH\nline 1\nline 2\n=======\nline A\nline B\n>>>>>>> REPLACE"
    );
    expect(blocks[0].search).toBe("line 1\nline 2");
    expect(blocks[0].replace).toBe("line A\nline B");
  });

  it("throws on unclosed block", () => {
    expect(() => parseEditBlocks("<<<<<<< SEARCH\nincomplete")).toThrow("unclosed");
  });

  it("throws on nested SEARCH marker", () => {
    expect(() =>
      parseEditBlocks("<<<<<<< SEARCH\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE")
    ).toThrow("nested");
  });

  it("throws on text outside block", () => {
    expect(() =>
      parseEditBlocks("random text\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE")
    ).toThrow("unexpected text");
  });

  it("ignores blank lines between blocks", () => {
    const blocks = parseEditBlocks(
      "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE"
    );
    expect(blocks).toHaveLength(2);
  });

  it("allows empty replace", () => {
    const blocks = parseEditBlocks("<<<<<<< SEARCH\nremove me\n=======\n>>>>>>> REPLACE");
    expect(blocks[0].search).toBe("remove me");
    expect(blocks[0].replace).toBe("");
  });
});

// ---- applyEdits ----
describe("applyEdits", () => {
  it("applies a single replacement", () => {
    const result = applyEdits("hello world", [
      { offset: 6, deleteLen: 5, replacement: "there" },
    ]);
    expect(result).toBe("hello there");
  });

  it("applies multiple edits in reverse order", () => {
    const result = applyEdits("abcdef", [
      { offset: 0, deleteLen: 1, replacement: "A" },
      { offset: 5, deleteLen: 1, replacement: "F" },
    ]);
    expect(result).toBe("AbcdeF");
  });

  it("handles insertion (deleteLen 0)", () => {
    const result = applyEdits("hello", [
      { offset: 5, deleteLen: 0, replacement: " world" },
    ]);
    expect(result).toBe("hello world");
  });

  it("handles deletion (empty replacement)", () => {
    const result = applyEdits("hello world", [
      { offset: 5, deleteLen: 6, replacement: "" },
    ]);
    expect(result).toBe("hello");
  });

  it("handles overlapping ranges by reverse-sorting first", () => {
    const result = applyEdits("abcdefgh", [
      { offset: 1, deleteLen: 3, replacement: "X" },
      { offset: 2, deleteLen: 3, replacement: "Y" },
    ]);
    expect(result).toBe("aXgh");
  });
});

// ---- whitespaceNormalize ----
describe("whitespaceNormalize", () => {
  it("collapses multiple spaces to one", () => {
    expect(whitespaceNormalize("a   b")).toBe("a b");
  });

  it("replaces tabs with spaces", () => {
    expect(whitespaceNormalize("a\tb")).toBe("a b");
  });

  it("handles CRLF", () => {
    expect(whitespaceNormalize("a\r\nb")).toBe("a b");
  });

  it("trims result", () => {
    expect(whitespaceNormalize("  text  ")).toBe("text");
  });

  it("handles newlines as spaces", () => {
    expect(whitespaceNormalize("line1\nline2")).toBe("line1 line2");
  });
});

// ---- levenshteinSimilarity ----
describe("levenshteinSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(levenshteinSimilarity("hello", "hello")).toBe(1);
  });

  it("returns 0 for completely different", () => {
    expect(levenshteinSimilarity("abc", "xyz")).toBe(0);
  });

  it("returns 1 for both empty", () => {
    expect(levenshteinSimilarity("", "")).toBe(1);
  });

  it("returns 0 for one empty", () => {
    expect(levenshteinSimilarity("abc", "")).toBe(0);
    expect(levenshteinSimilarity("", "abc")).toBe(0);
  });

  it("computes partial similarity", () => {
    const sim = levenshteinSimilarity("kitten", "sitting");
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThan(1);
  });

  it("is symmetric", () => {
    expect(levenshteinSimilarity("abc", "abd")).toBe(
      levenshteinSimilarity("abd", "abc")
    );
  });
});

// ---- globToRegex ----
describe("globToRegex", () => {
  it("converts * to .*", () => {
    const re = globToRegex("*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("foo.tsx")).toBe(false);
  });

  it("converts ? to single char", () => {
    const re = globToRegex("file?.ts");
    expect(re.test("file1.ts")).toBe(true);
    expect(re.test("file10.ts")).toBe(false);
  });

  it("handles {a,b} alternation", () => {
    const re = globToRegex("*.{ts,tsx}");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("foo.tsx")).toBe(true);
    expect(re.test("foo.js")).toBe(false);
  });

  it("escapes dots", () => {
    const re = globToRegex("test.ts");
    expect(re.test("test.ts")).toBe(true);
    expect(re.test("testXts")).toBe(false);
  });

  it("escapes regex special chars", () => {
    const re = globToRegex("file[0-9].ts");
    expect(re.test("file[0-9].ts")).toBe(true);
    expect(re.test("file0.ts")).toBe(false);
  });
});

// ---- isBinaryFile ----
describe("isBinaryFile", () => {
  it("detects null byte as binary", () => {
    const buf = Buffer.from([0x00, 0x48, 0x65]);
    expect(isBinaryFile(buf)).toBe(true);
  });

  it("returns false for plain text", () => {
    const buf = Buffer.from("hello world");
    expect(isBinaryFile(buf)).toBe(false);
  });

  it("returns false for empty buffer", () => {
    expect(isBinaryFile(Buffer.alloc(0))).toBe(false);
  });

  it("checks only first 8192 bytes", () => {
    const buf = Buffer.alloc(10000, 0x41);
    buf[9000] = 0;
    expect(isBinaryFile(buf)).toBe(false);
  });
});

// ---- isSkipDir ----
describe("isSkipDir", () => {
  it("skips node_modules by default", () => {
    expect(isSkipDir("node_modules")).toBe(true);
  });

  it("skips .git by default", () => {
    expect(isSkipDir(".git")).toBe(true);
  });

  it("does not skip normal dirs", () => {
    expect(isSkipDir("src")).toBe(false);
  });

  it("skips user-defined dirs", () => {
    expect(isSkipDir("build", ["build"])).toBe(true);
  });
});

// ---- findNewlineType ----
describe("findNewlineType", () => {
  it("detects CRLF", () => {
    expect(findNewlineType("a\r\nb")).toBe("\r\n");
  });

  it("defaults to LF", () => {
    expect(findNewlineType("a\nb")).toBe("\n");
  });

  it("returns LF for empty string", () => {
    expect(findNewlineType("")).toBe("\n");
  });
});

// ---- mergeContextWindows ----
describe("mergeContextWindows", () => {
  it("merges overlapping windows", () => {
    const merged = mergeContextWindows([5, 6], 10, 2);
    expect(merged).toEqual([{ start: 3, end: 8 }]);
  });

  it("keeps separate non-overlapping windows", () => {
    const merged = mergeContextWindows([2, 8], 10, 1);
    expect(merged).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(mergeContextWindows([], 10, 2)).toEqual([]);
  });

  it("clamps to line bounds", () => {
    const merged = mergeContextWindows([1], 5, 2);
    expect(merged[0].start).toBe(1);
    expect(merged[0].end).toBe(3);
  });
});

// ---- limitedWireFormat ----
describe("limitedWireFormat", () => {
  it("formats without truncation", () => {
    const result = limitedWireFormat(["a", "b"], 10, "file", "files");
    expect(result).toBe("2 files found:\na\nb");
  });

  it("truncates when over limit", () => {
    const result = limitedWireFormat(["a", "b", "c"], 2, "file", "files");
    expect(result).toContain("3 files found (showing first 2)");
    expect(result).toContain("[truncated after 2 entries — 1 more; narrow the pattern or path]");
    expect(result).toContain("a\nb");
    expect(result).toContain("[truncated after 2 entries");
  });

  it("uses singular for 1 item", () => {
    const result = limitedWireFormat(["a"], 10, "file", "files");
    expect(result).toBe("1 file found:\na");
  });
});

// ---- list_dir tool ----
describe("createListDirTool", () => {
  let cwd: string;
  beforeEach(() => { cwd = setupFixture(); });
  afterEach(cleanupFixture);

  it("lists directory contents", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.list_dir.execute!({ path: cwd }, {});
    expect(result).toContain("hello.txt");
    expect(result).toContain("data.json");
    expect(result).toContain("src.ts");
    expect(result).toContain("subdir");
    expect(result).toContain("[dir");
    expect(result).toContain("[file]");
  });

  it("defaults to cwd when no path given", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.list_dir.execute!({}, {});
    expect(result).toContain("hello.txt");
  });

  it("returns error for non-existent path", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.list_dir.execute!({ path: path.join(cwd, "nonexistent") }, {});
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error for file path", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.list_dir.execute!({ path: path.join(cwd, "hello.txt") }, {});
    expect(result).toContain("Error");
    expect(result).toContain("not a directory");
  });
});

// ---- find_files tool ----
describe("createFindFilesTool", () => {
  let cwd: string;
  beforeEach(() => { cwd = setupFixture(); });
  afterEach(cleanupFixture);

  it("finds files by regex", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.find_files.execute!({ pattern: ".*\\.ts" }, {});
    expect(result).toContain("src.ts");
    expect(result).toContain("nested.ts");
    expect(result).not.toContain("hello.txt");
  });

  it("returns zero for no match", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.find_files.execute!({ pattern: "nonexistent" }, {});
    expect(result).toBe("0 files found");
  });

  it("respects path option", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.find_files.execute!({
      pattern: ".*",
      path: path.join(cwd, "subdir"),
    }, {});
    expect(result).toContain("nested.txt");
    expect(result).toContain("nested.ts");
    expect(result).not.toContain("hello.txt");
  });

  it("returns error for invalid regex", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.find_files.execute!({ pattern: "[" }, {});
    expect(result).toContain("Error");
    expect(result).toContain("invalid regex");
  });

  it("skips node_modules by default", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.find_files.execute!({ pattern: "should-skip.*" }, {});
    expect(result).toBe("0 files found");
  });
});

// ---- grep tool ----
describe("createGrepTool", () => {
  let cwd: string;
  beforeEach(() => { cwd = setupFixture(); });
  afterEach(cleanupFixture);

  it("finds matching lines", async () => {
    const tools = fileTools(opts(cwd));
    // Use a path within the fixtures directory
    const result = await tools.grep.execute!({
      pattern: "const",
      path: cwd,
    }, {});
    expect(result).toContain("src.ts");
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("hello.txt");
  });

  it("returns zero for no match", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.grep.execute!({
      pattern: "zzz_nonexistent",
      path: cwd,
    }, {});
    expect(result).toBe("0 matches found");
  });

  it("respects include filter", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.grep.execute!({
      pattern: ".*",
      path: cwd,
      include: "*.json",
    }, {});
    expect(result).toContain("data.json");
    expect(result).not.toContain("hello.txt");
  });

  it("handles context_lines", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.grep.execute!({
      pattern: "function",
      path: cwd,
      context_lines: 1,
    }, {});
    expect(typeof result).toBe("string");
  });

  it("returns error for invalid regex", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.grep.execute!({
      pattern: "[",
      path: cwd,
    }, {});
    expect(result).toContain("Error");
    expect(result).toContain("invalid regex");
  });

  it("returns error for invalid include glob", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.grep.execute!({
      pattern: "test",
      path: cwd,
      include: "*.{ts",
    }, {});
    expect(result).toContain("Error");
    expect(result).toContain("invalid include");
  });

  it("skips binary files", async () => {
    const binPath = path.join(cwd, "binary.bin");
    fs.writeFileSync(binPath, Buffer.from([0x00, 0x48, 0x65]));
    const tools = fileTools(opts(cwd));
    const result = await tools.grep.execute!({
      pattern: ".*",
      path: cwd,
    }, {});
    expect(result).not.toContain("binary.bin");
  });
});

// ---- edit tool ----
describe("createEditTool", () => {
  let cwd: string;
  beforeEach(() => { cwd = setupFixture(); });
  afterEach(cleanupFixture);

  it("applies exact match edit", async () => {
    const tools = fileTools(opts(cwd));
    const filePath = path.join(cwd, "hello.txt");
    const result = await tools.edit.execute!({
      path: filePath,
      block: "<<<<<<< SEARCH\nhello\n=======\nhi\n>>>>>>> REPLACE",
    }, {});
    expect(result).toContain("edited successfully");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toBe("hi world\n");
  });

  it("returns error when search not found", async () => {
    const tools = fileTools(opts(cwd));
    const filePath = path.join(cwd, "hello.txt");
    const result = await tools.edit.execute!({
      path: filePath,
      block: "<<<<<<< SEARCH\nnonexistent text\n=======\nreplacement\n>>>>>>> REPLACE",
    }, {});
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("returns error for malformed block", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.edit.execute!({
      path: path.join(cwd, "hello.txt"),
      block: "not a valid block",
    }, {});
    expect(result).toContain("Error");
    expect(result).toContain("unexpected text");
  });

  it("returns error for file not found", async () => {
    const tools = fileTools(opts(cwd));
    const result = await tools.edit.execute!({
      path: path.join(cwd, "nonexistent.txt"),
      block: "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE",
    }, {});
    expect(result).toContain("Error reading file");
  });

  it("preserves CRLF line endings", async () => {
    const filePath = path.join(cwd, "crlf.txt");
    fs.writeFileSync(filePath, "line1\r\nline2\r\nline3\r\n");
    const tools = fileTools(opts(cwd));
    await tools.edit.execute!({
      path: filePath,
      block: "<<<<<<< SEARCH\nline2\n=======\nreplaced\n>>>>>>> REPLACE",
    }, {});
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toBe("line1\r\nreplaced\r\nline3\r\n");
  });

  it("applies multiple blocks atomically", async () => {
    const filePath = path.join(cwd, "multi.txt");
    fs.writeFileSync(filePath, "first\nsecond\nthird\n");
    const tools = fileTools(opts(cwd));
    const result = await tools.edit.execute!({
      path: filePath,
      block:
        "<<<<<<< SEARCH\nfirst\n=======\nFIRST\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nthird\n=======\nTHIRD\n>>>>>>> REPLACE",
    }, {});
    expect(result).toContain("edited successfully");
    expect(result).toContain("2 blocks applied");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toBe("FIRST\nsecond\nTHIRD\n");
  });

  it("returns error on multiple exact matches", async () => {
    const filePath = path.join(cwd, "dup.txt");
    fs.writeFileSync(filePath, "dup\nother\ndup\n");
    const tools = fileTools(opts(cwd));
    const result = await tools.edit.execute!({
      path: filePath,
      block: "<<<<<<< SEARCH\ndup\n=======\nreplaced\n>>>>>>> REPLACE",
    }, {});
    expect(result).toContain("Error");
    expect(result).toContain("Multiple exact matches");
  });

  it("finds whitespace-normalized matches", async () => {
    const filePath = path.join(cwd, "spacey.txt");
    fs.writeFileSync(filePath, "hello   world\n");
    const tools = fileTools(opts(cwd));
    const result = await tools.edit.execute!({
      path: filePath,
      block: "<<<<<<< SEARCH\nhello world\n=======\nhi there\n>>>>>>> REPLACE",
    }, {});
    expect(result).toContain("edited successfully");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toBe("hi there\n");
  });

  it("applies fuzzy matches above threshold", async () => {
    const tools = fileTools(
      fileToolsOptionsSchema.parse({ cwd, fuzzyThreshold: 0.5 }),
    );
    const filePath = path.join(cwd, "fuzzy.txt");
    fs.writeFileSync(filePath, "const variableName = calculateSum(a, b);\n");
    const result = await tools.edit.execute!({
      path: filePath,
      block: "<<<<<<< SEARCH\nconst varName = calculateSum(a, b, {});\n=======\nconst x = calc(a, b);\n>>>>>>> REPLACE",
    });
    expect(result).toContain("edited successfully");
  });
});

// ---- fileTools entry point ----
describe("fileTools", () => {
  it("returns all four tools", () => {
    const tools = fileTools();
    expect(tools).toHaveProperty("edit");
    expect(tools).toHaveProperty("find_files");
    expect(tools).toHaveProperty("grep");
    expect(tools).toHaveProperty("list_dir");
  });

  it("each tool has description and inputSchema", () => {
    const tools = fileTools();
    for (const name of ["edit", "find_files", "grep", "list_dir"]) {
      const tool = tools[name as keyof typeof tools];
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });
});
