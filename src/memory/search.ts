import * as path from "node:path";
import { Mem } from "./store.js";
import type { SearchHit } from "./types.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractContext(
  lines: string[],
  matchIndexes: number[],
  contextLines = 3,
  maxRegions = 5,
): string {
  const regions: Array<{ start: number; end: number }> = [];
  for (const idx of matchIndexes) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lines.length, idx + contextLines + 1);

    let merged = false;
    for (const r of regions) {
      if (
        start <= r.end + contextLines &&
        end >= r.start - contextLines
      ) {
        r.start = Math.min(r.start, start);
        r.end = Math.max(r.end, end);
        merged = true;
        break;
      }
    }
    if (!merged) {
      regions.push({ start, end });
    }
  }

  regions.sort((a, b) => a.start - b.start);
  const topRegions = regions.slice(0, maxRegions);

  const snippets: string[] = [];
  for (let i = 0; i < topRegions.length; i++) {
    const r = topRegions[i];
    if (i > 0 && r.start > (topRegions[i - 1].end ?? 0)) {
      snippets.push("…");
    }
    snippets.push(lines.slice(r.start, r.end).join("\n"));
  }

  return snippets.join("\n");
}

export async function search(
  mem: Mem,
  query: string,
): Promise<SearchResults> {
  const rawTerms = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const terms = [...new Set(rawTerms)];
  if (terms.length === 0) {
    return new SearchResults([], {});
  }

  const filePaths = await mem.collectMdFiles();
  const hits: SearchHit[] = [];
  const termCounts: Record<string, number> = {};

  for (const filePath of filePaths) {
    let content: string;
    try {
      content = (await mem.read(filePath)) ?? "";
    } catch {
      continue;
    }

    const fileName = path.basename(filePath, ".md");
    const isGlobal =
      path.basename(filePath) === "MEMORY.md" &&
      path.dirname(filePath) === mem.root;
    const isDaily = /^\d{4}-\d{2}-\d{2}$/.test(fileName);
    const dateStr = isDaily ? fileName : undefined;

    const matchedTerms: string[] = [];
    const matchLines: number[] = [];
    let contentMatch = false;

    const lines = content.split("\n");
    const lowerContent = content.toLowerCase();

    for (const term of terms) {
      const lowerTerm = term.toLowerCase();
      if (lowerContent.includes(lowerTerm)) {
        matchedTerms.push(term);
        termCounts[term] = (termCounts[term] ?? 0) + 1;
        contentMatch = true;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerTerm)) {
            matchLines.push(i);
          }
        }
      }
    }

    if (!contentMatch) {
      const lowerName = fileName.toLowerCase();
      let nameMatch = false;
      for (const term of terms) {
        if (lowerName.includes(term.toLowerCase())) {
          matchedTerms.push(term);
          termCounts[term] = (termCounts[term] ?? 0) + 1;
          nameMatch = true;
        }
      }
      if (!nameMatch) continue;
    }

    const uniqueMatchLines = [...new Set(matchLines)];
    const body = contentMatch
      ? extractContext(lines, uniqueMatchLines)
      : lines.slice(0, 10).join("\n");

    hits.push({
      path: path.relative(mem.root, filePath),
      matchedTerms,
      body,
      contentMatch,
      matchCount: uniqueMatchLines.length,
      isDaily,
      dateStr,
    });
  }

  return new SearchResults(hits, termCounts);
}

function rankScore(hit: SearchHit, numTerms: number): number {
  let score = 0;

  if (
    hit.path === "MEMORY.md" ||
    hit.path.endsWith("/MEMORY.md")
  ) {
    score += 1000;
  }

  score += hit.matchedTerms.length * 100;

  if (hit.contentMatch) score += 50;

  score += Math.min(hit.matchCount, 20);

  if (hit.isDaily && hit.dateStr) {
    score += 10;
    const recent = hit.dateStr > "2024-01-01" ? 5 : 0;
    score += recent;
  }

  return score;
}

export class SearchResults {
  constructor(
    public hits: SearchHit[],
    public termCounts: Record<string, number>,
  ) {}

  rankedHits(): SearchHit[] {
    const numTerms = Object.keys(this.termCounts).length;
    return [...this.hits].sort((a, b) => {
      const scoreA = rankScore(a, numTerms);
      const scoreB = rankScore(b, numTerms);
      if (scoreB !== scoreA) return scoreB - scoreA;
      if (b.isDaily !== a.isDaily) return a.isDaily ? 1 : -1;
      if (b.contentMatch !== a.contentMatch) return a.contentMatch ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  }

  render(maxBytes: number): string {
    const ranked = this.rankedHits();
    if (ranked.length === 0) {
      return "No matches found.";
    }

    const header =
      Object.entries(this.termCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([t, c]) => `${t}: ${c}`)
        .join(", ") + "\n\n";

    let remaining = maxBytes - Buffer.byteLength(header, "utf-8");
    if (remaining <= 0) return header;

    const included: string[] = [];
    let omitted = 0;

    for (const hit of ranked) {
      const prefix = `## ${hit.path}\n`;
      const block = prefix + hit.body + "\n\n";
      const blockBytes = Buffer.byteLength(block, "utf-8");

      if (blockBytes <= remaining) {
        included.push(block);
        remaining -= blockBytes;
      } else if (remaining > Buffer.byteLength(prefix, "utf-8")) {
        included.push(
          block.slice(
            0,
            remaining,
          ) + "\n…[truncated]",
        );
        remaining = 0;
        omitted++;
      } else {
        omitted++;
      }
    }

    let result = header + included.join("");
    if (omitted > 0) {
      result += `\n(${omitted} result(s) omitted due to size limit)`;
    }
    return result;
  }
}
