import * as fs from "node:fs";
import type { Tool } from "ai";
import { z } from "zod";
import {
  resolvePath,
  parseEditBlocks,
  applyEdits,
  whitespaceNormalize,
  levenshteinSimilarity,
  findNewlineType,
} from "./utils.js";
import type { FileToolsOptions, EditBlock, EditMatch } from "./types.js";
import { resolveOptions } from "./types.js";

function exactMatch(
  content: string,
  search: string,
  blockIndex: number,
): EditMatch[] {
  const matches: EditMatch[] = [];
  let start = 0;
  while ((start = content.indexOf(search, start)) !== -1) {
    matches.push({
      blockIndex,
      start,
      end: start + search.length,
      method: "exact",
    });
    start += search.length;
  }
  return matches;
}

function whitespaceMatch(
  content: string,
  search: string,
  blockIndex: number,
): EditMatch[] {
  const norm = whitespaceNormalize(content);
  const normSearch = whitespaceNormalize(search);

  const matches: EditMatch[] = [];
  let start = 0;
  while ((start = norm.indexOf(normSearch, start)) !== -1) {
    const end = start + normSearch.length;

    const origStart = mapNormToOrig(content, norm, start);
    const origEnd = mapNormToOrig(content, norm, end);
    if (origStart !== null && origEnd !== null) {
      matches.push({
        blockIndex,
        start: origStart,
        end: origEnd,
        method: "whitespace",
      });
    }
    start = end;
  }
  return matches;
}

function mapNormToOrig(
  orig: string,
  norm: string,
  normPos: number,
): number | null {
  let op = 0;
  let np = 0;

  while (op < orig.length && np < norm.length && np < normPos) {
    if (orig[op] === "\r" && op + 1 < orig.length && orig[op + 1] === "\n") {
      op += 2;
      if (np < norm.length && norm[np] === " ") {
        np++;
        continue;
      }
      np++;
      continue;
    }
    if (orig[op] === "\t") {
      op++;
      let spaceCount = 0;
      while (np + spaceCount < norm.length && spaceCount < 4 && norm[np + spaceCount] === " ") {
        spaceCount++;
      }
      np += Math.max(1, spaceCount);
      continue;
    }
    if (orig[op] === " " && op > 0 && orig[op - 1] === " ") {
      op++;
      continue;
    }
    op++;
    np++;
  }

  return op;
}

function fuzzyLineMatch(
  content: string,
  search: string,
  blockIndex: number,
  threshold: number,
): EditMatch[] {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");

  if (searchLines.length > contentLines.length) return [];

  const normSearchLines = searchLines.map((l) => whitespaceNormalize(l));
  const normContentLines = contentLines.map((l) => whitespaceNormalize(l));

  let bestSimilarity = 0;
  let bestOffset = 0;
  let bestEnd = 0;

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const windowNorm = normContentLines.slice(i, i + searchLines.length).join(" ");
    const searchNorm = normSearchLines.join(" ");
    const sim = levenshteinSimilarity(windowNorm, searchNorm);

    if (sim > bestSimilarity) {
      bestSimilarity = sim;

      let byteOffset = 0;
      for (let j = 0; j < i; j++) {
        byteOffset += contentLines[j].length + 1;
      }

      if (i + searchLines.length <= contentLines.length) {
        let byteEnd = byteOffset;
        for (let j = i; j < i + searchLines.length; j++) {
          byteEnd += contentLines[j].length;
          if (j < i + searchLines.length - 1) byteEnd += 1;
        }
        bestEnd = byteEnd;
      }
      bestOffset = byteOffset;
    }
  }

  if (bestSimilarity >= threshold) {
    return [
      {
        blockIndex,
        start: bestOffset,
        end: bestEnd,
        method: "fuzzy",
        similarity: bestSimilarity,
      },
    ];
  }

  return [];
}

function findMatches(
  content: string,
  block: EditBlock,
  blockIndex: number,
  threshold: number,
): { matches: EditMatch[]; error?: string } {
  let matches = exactMatch(content, block.search, blockIndex);

  if (matches.length > 1) {
    const locations = matches
      .map((m) => {
        const line = content.slice(0, m.start).split("\n").length;
        const col = m.start - content.lastIndexOf("\n", m.start - 1) + 1;
        return `  line ${line}, col ${col}`;
      })
      .join("\n");
    return {
      matches: [],
      error: `Multiple exact matches found for block ${blockIndex + 1}:\n${locations}\n\nAdd more context to the search to make it unique.`,
    };
  }

  if (matches.length === 1) {
    return { matches };
  }

  matches = whitespaceMatch(content, block.search, blockIndex);
  if (matches.length > 0) {
    return { matches };
  }

  matches = fuzzyLineMatch(
    content,
    block.search,
    blockIndex,
    threshold,
  );
  if (matches.length > 0) {
    return { matches };
  }

  const bestFuzzy = fuzzyLineMatch(
    content,
    block.search,
    blockIndex,
    0.6,
  );
  if (bestFuzzy.length > 0) {
    const simPercent = Math.round(bestFuzzy[0].similarity! * 100);
    const line = content.slice(0, bestFuzzy[0].start).split("\n").length;
    return {
      matches: [],
      error: `No exact match found for block ${blockIndex + 1}. Closest match has ${simPercent}% similarity at line ${line} (threshold is ${Math.round(threshold * 100)}%). Provide a more precise search block.`,
    };
  }

  return {
    matches: [],
    error: `Search text not found in file for block ${blockIndex + 1}.`,
  };
}

export const editInputSchema = z.object({
  path: z.string().describe("Path to the file (relative or absolute)"),
  block: z.string().describe(
    "One or more <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks",
  ),
});

export function createEditTool(options?: FileToolsOptions): Tool {
  const opts = resolveOptions(options);

  return {
    description:
      "Edit a file using aider-style SEARCH/REPLACE blocks. Each block finds exact text and replaces it. Multiple blocks in one call are applied atomically. If the search text is not an exact match, whitespace normalization and fuzzy matching are attempted as fallbacks.",
    inputSchema: editInputSchema,
    execute: async (input: z.infer<typeof editInputSchema>, _opts?: unknown) => {
      const target = resolvePath(input.path, opts.cwd);

      let blocks: EditBlock[];
      try {
        blocks = parseEditBlocks(input.block);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error parsing edit blocks: ${message}`;
      }

      if (blocks.length === 0) {
        return "Error: no SEARCH/REPLACE blocks provided";
      }

      let content: string;
      try {
        content = fs.readFileSync(target, "utf-8");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error reading file: ${message}`;
      }

      const newlineType = findNewlineType(content);

      const allMatches: EditMatch[] = [];
      const errors: string[] = [];

      for (let i = 0; i < blocks.length; i++) {
        const result = findMatches(content, blocks[i], i, opts.fuzzyThreshold);
        if (result.error) {
          errors.push(result.error);
        }
        allMatches.push(...result.matches);
      }

      if (errors.length > 0) {
        return `Error:\n${errors.join("\n")}`;
      }

      const edits = allMatches.map((m) => ({
        offset: m.start,
        deleteLen: m.end - m.start,
        replacement: blocks[m.blockIndex].replace,
      }));

      const newContent = applyEdits(content, edits);

      if (newlineType === "\r\n" && !newContent.includes("\r\n")) {
        const normalized = newContent.replace(/\n/g, "\r\n");
        fs.writeFileSync(target, normalized, "utf-8");
      } else {
        fs.writeFileSync(target, newContent, "utf-8");
      }

      const matchDetails = allMatches
        .map((m) => {
          const line = content.slice(0, m.start).split("\n").length;
          return `  block ${m.blockIndex + 1}: ${m.method} match at line ${line}`;
        })
        .join("\n");

      return `File edited successfully.${blocks.length > 1 ? ` ${blocks.length} blocks applied.` : ""}\n${matchDetails}`;
    },
  };
}
