import * as path from "node:path";
import * as fs from "node:fs";
import type { EditBlock, GrepMatch } from "./types.js";

export function resolvePath(input: string, cwd: string): string {
  if (path.isAbsolute(input)) return path.normalize(input);
  return path.normalize(path.join(cwd, input));
}

export function parseEditBlocks(block: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  const lines = block.split("\n");

  let state: "idle" | "search" | "replace" = "idle";
  let searchLines: string[] = [];
  let replaceLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("<<<<<<< SEARCH")) {
      if (state !== "idle") {
        throw new Error(
          "Malformed edit block: nested SEARCH marker found",
        );
      }
      state = "search";
      searchLines = [];
    } else if (line.startsWith("=======") && state === "search") {
      state = "replace";
      replaceLines = [];
    } else if (line.startsWith(">>>>>>> REPLACE") && state === "replace") {
      blocks.push({
        search: searchLines.join("\n"),
        replace: replaceLines.join("\n"),
      });
      state = "idle";
    } else if (state === "search") {
      searchLines.push(line);
    } else if (state === "replace") {
      replaceLines.push(line);
    } else if (state === "idle" && line.trim() !== "") {
      throw new Error(
        `Malformed edit block: unexpected text outside SEARCH/REPLACE block: "${line}"`,
      );
    }
  }

  if (state !== "idle") {
    throw new Error("Malformed edit block: unclosed SEARCH/REPLACE block");
  }

  return blocks;
}

export function applyEdits(
  content: string,
  edits: { offset: number; deleteLen: number; replacement: string }[],
): string {
  const sorted = [...edits].sort((a, b) => b.offset - a.offset);

  let result = content;
  for (const edit of sorted) {
    result =
      result.slice(0, edit.offset) +
      edit.replacement +
      result.slice(edit.offset + edit.deleteLen);
  }
  return result;
}

export function whitespaceNormalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\t/g, "    ").replace(/\s+/g, " ").trim();
}

export function levenshteinSimilarity(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return 1;
  if (m === 0 || n === 0) return 0;

  let prev = new Uint32Array(n + 1);
  let curr = new Uint32Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }

  const distance = prev[n];
  const maxLen = Math.max(m, n);
  return 1 - distance / maxLen;
}

export function computeByteRange(
  original: string,
  normalized: string,
  normStart: number,
  normEnd: number,
): { start: number; end: number } | null {
  let origPos = 0;
  let normPos = 0;

  while (origPos < original.length && normPos < normalized.length && normPos < normStart) {
    if (original[origPos] === "\r" && original[origPos + 1] === "\n") {
      if (normalized[normPos] === " ") { origPos += 2; normPos++; continue; }
      origPos += 2;
      normPos++;
      continue;
    }
    if (original[origPos] === "\t") {
      origPos++;
      let spacesSkipped = 0;
      while (spacesSkipped < 4 && normPos + spacesSkipped < normalized.length && normalized[normPos + spacesSkipped] === " ") {
        spacesSkipped++;
      }
      normPos += spacesSkipped;
      continue;
    }
    if (original[origPos] === " " && origPos > 0 && original[origPos - 1] === " ") {
      origPos++;
      continue;
    }
    origPos++;
    normPos++;
  }

  const start = origPos;

  while (origPos < original.length && normPos < normalized.length && normPos < normEnd) {
    if (original[origPos] === "\r" && original[origPos + 1] === "\n") {
      if (normalized[normPos] === " ") { origPos += 2; normPos++; continue; }
      origPos += 2;
      normPos++;
      continue;
    }
    if (original[origPos] === "\t") {
      origPos++;
      let spacesSkipped = 0;
      while (spacesSkipped < 4 && normPos + spacesSkipped < normalized.length && normalized[normPos + spacesSkipped] === " ") {
        spacesSkipped++;
      }
      normPos += spacesSkipped;
      continue;
    }
    if (original[origPos] === " " && origPos > 0 && original[origPos - 1] === " ") {
      origPos++;
      continue;
    }
    origPos++;
    normPos++;
  }

  return { start, end: origPos };
}

export function globToRegex(glob: string): RegExp {
  let pattern = "";

  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    switch (ch) {
      case ".": pattern += "\\."; break;
      case "*": pattern += ".*"; break;
      case "?": pattern += "."; break;
      case "{": {
        const close = glob.indexOf("}", i);
        if (close === -1) {
          throw new Error(`Unclosed '{' in glob pattern at position ${i}`);
        }
        const inner = glob.slice(i + 1, close);
        const alternatives = inner.split(",").map((a) =>
          a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
        );
        pattern += "(?:" + alternatives.join("|") + ")";
        i = close;
        break;
      }
      default:
        if (/[.+^${}()|[\]\\]/.test(ch)) {
          pattern += "\\" + ch;
        } else {
          pattern += ch;
        }
    }
  }

  return new RegExp("^" + pattern + "$");
}

export function isBinaryFile(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function isSkipDir(name: string, extra: string[] = []): boolean {
  const defaults = ["node_modules", "target", ".git"];
  return defaults.includes(name) || extra.includes(name);
}

export function findNewlineType(content: string): "\n" | "\r\n" {
  if (content.includes("\r\n")) return "\r\n";
  return "\n";
}

export function mergeContextWindows(
  matchLines: number[],
  totalLines: number,
  context: number,
): Array<{ start: number; end: number }> {
  if (matchLines.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = matchLines.map((l) => ({
    start: Math.max(1, l - context),
    end: Math.min(totalLines, l + context),
  }));

  const merged: Array<{ start: number; end: number }> = [ranges[0]];

  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i].start <= last.end + 1) {
      last.end = Math.max(last.end, ranges[i].end);
    } else {
      merged.push(ranges[i]);
    }
  }

  return merged;
}

export function formatGrepOutput(
  filePath: string,
  lines: string[],
  matches: GrepMatch[],
  contextLines: number,
): string {
  if (contextLines === 0) {
    return matches
      .filter((m) => !m.isContext)
      .map((m) => `${filePath}:${m.line}:${m.text}`)
      .join("\n");
  }

  const matchLineNums = matches.filter((m) => !m.isContext).map((m) => m.line);
  const windows = mergeContextWindows(matchLineNums, lines.length, contextLines);

  const result: string[] = [];

  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    if (wi > 0) result.push("--");

    for (let l = w.start; l <= w.end; l++) {
      const isMatch = matches.some((m) => !m.isContext && m.line === l);
      const sep = isMatch ? ":" : "-";
      result.push(`${filePath}${sep}${l}${sep}${lines[l - 1]}`);
    }
  }

  return result.join("\n");
}

export function limitedWireFormat(
  items: string[],
  limit: number,
  itemLabel: string,
  labelPlural: string,
): string {
  const show = items.slice(0, limit);
  let result = `${items.length} ${items.length === 1 ? itemLabel : labelPlural} found`;

  if (items.length > limit) {
    result += ` (showing first ${limit})`;
  }
  result += ":\n" + show.join("\n");

  if (items.length > limit) {
    result += `\n[truncated after ${limit} entries — ${items.length - limit} more; narrow the pattern or path]`;
  }

  return result;
}
