import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { MemoryConfigSchema } from "./types.js";
import type { MemoryConfig, WriteMode } from "./types.js";

function defaultBaseDir(): string {
  if (process.platform === "linux" || process.platform === "freebsd") {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) return path.join(xdg, "ai-sdk-layer", "memory");
    return path.join(os.homedir(), ".local", "share", "ai-sdk-layer", "memory");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "ai-sdk-layer",
      "memory",
    );
  }
  return path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "ai-sdk-layer",
    "memory",
  );
}

function projectSlug(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, content, "utf-8");
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new Error(`Failed to atomically write ${filePath}`);
  }
}

function backupFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const bak = filePath.replace(/\.md$/, ".bak");
  fs.copyFileSync(filePath, bak);
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

export class Mem {
  readonly root: string;
  readonly projectSlug: string;
  readonly today: string;
  readonly maxInjectBytes: number;
  readonly maxWriteBytes: number;
  readonly maxSearchBytes: number;

  constructor(config?: MemoryConfig) {
    const parsed = MemoryConfigSchema.parse(config ?? {});
    this.root = parsed.baseDir ?? defaultBaseDir();
    this.projectSlug = projectSlug();
    this.today = new Date().toISOString().slice(0, 10);
    this.maxInjectBytes = parsed.maxInjectBytes;
    this.maxWriteBytes = parsed.maxWriteBytes;
    this.maxSearchBytes = parsed.maxSearchBytes;
  }

  static open(config?: MemoryConfig): Mem {
    return new Mem(config);
  }

  longTermPath(): string {
    return path.join(this.root, "MEMORY.md");
  }

  scratchpadPath(): string {
    return path.join(this.root, "projects", this.projectSlug, "SCRATCHPAD.md");
  }

  dailyPath(date: string): string {
    return path.join(
      this.root,
      "projects",
      this.projectSlug,
      "daily",
      `${date}.md`,
    );
  }

  todayPath(): string {
    return this.dailyPath(this.today);
  }

  notePath(name: string): string {
    const sanitized = name
      .replace(/\.md$/i, "")
      .replace(/[/\\]/g, "_")
      .replace(/\./g, "_");
    return path.join(
      this.root,
      "projects",
      this.projectSlug,
      "notes",
      `${sanitized}.md`,
    );
  }

  isSafeDailyName(date: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(date);
  }

  async read(filePath: string): Promise<string | null> {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  async write(
    targetPath: string,
    content: string,
    mode: WriteMode,
    targetType: "long_term" | "scratchpad" | "daily" | "note",
  ): Promise<string> {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });

    let finalContent = content;

    if (targetType === "daily") {
      mode = "append";
    }

    if (mode === "append" && targetType === "long_term") {
      const existing = await this.read(targetPath);
      const existingLines = existing
        ? existing
            .split("\n")
            .map(normalizeLine)
            .filter((l) => l.length > 0)
        : [];

      const newLines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const toAdd: string[] = [];
      const duplicates: string[] = [];
      const seen = new Set(existingLines);

      for (const line of newLines) {
        const normalized = normalizeLine(line);
        if (seen.has(normalized)) {
          duplicates.push(line);
        } else {
          toAdd.push(line);
          seen.add(normalized);
        }
      }

      if (toAdd.length === 0) {
        return `(skipped ${duplicates.length} duplicate line(s), nothing new to write)`;
      }

      const base = existing ? existing.trimEnd() + "\n" : "";
      finalContent = base + toAdd.join("\n") + "\n";

      if (duplicates.length > 0) {
        finalContent +=
          "\n" + `(skipped ${duplicates.length} duplicate line(s))`;
      }
    } else if (mode === "append") {
      const existing = await this.read(targetPath);
      if (existing && existing.trim().length > 0) {
        finalContent = existing.trimEnd() + "\n" + content + "\n";
      } else {
        finalContent = content + "\n";
      }
    }

    if (
      finalContent.length > this.maxWriteBytes &&
      targetType !== "daily"
    ) {
      const trunc =
        finalContent.slice(0, this.maxWriteBytes) +
        `\n…[content truncated at ${this.maxWriteBytes}B]`;
      finalContent = trunc;
    }

    const needsBackup =
      mode === "overwrite" &&
      (targetType === "long_term" || targetType === "scratchpad");

    if (needsBackup) {
      backupFile(targetPath);
    }

    atomicWrite(targetPath, finalContent);

    const verb = mode === "overwrite" ? "Wrote" : "Appended to";
    return `${verb} ${path.relative(this.root, targetPath)}`;
  }

  async appendDaily(heading: string, content: string): Promise<void> {
    const now = new Date();
    const hhmm =
      String(now.getHours()).padStart(2, "0") +
      ":" +
      String(now.getMinutes()).padStart(2, "0");
    const entry = `### ${hhmm} — ${heading}\n${content}\n`;
    const targetPath = this.todayPath();
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });

    const existing = await this.read(targetPath);
    const finalContent = existing
      ? existing.trimEnd() + "\n" + entry
      : entry;
    atomicWrite(targetPath, finalContent);
  }

  async listDailyFiles(): Promise<string[]> {
    const dailyDir = path.dirname(this.todayPath());
    try {
      const entries = fs.readdirSync(dailyDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name.replace(/\.md$/, ""))
        .filter((n) => this.isSafeDailyName(n))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  async listNotes(): Promise<string[]> {
    const notesDir = path.dirname(this.notePath("_"));
    try {
      const entries = fs.readdirSync(notesDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name.replace(/\.md$/, ""));
    } catch {
      return [];
    }
  }

  async collectMdFiles(): Promise<string[]> {
    const files: string[] = [];

    const global = this.longTermPath();
    if (fs.existsSync(global)) files.push(global);

    const projectDir = path.join(this.root, "projects", this.projectSlug);
    if (!fs.existsSync(projectDir)) return files;

    const notesDir = path.join(projectDir, "notes");
    if (fs.existsSync(notesDir)) {
      try {
        for (const entry of fs.readdirSync(notesDir, {
          withFileTypes: true,
        })) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            files.push(path.join(notesDir, entry.name));
          }
        }
      } catch {
        /* skip */
      }
    }

    const dailyDir = path.join(projectDir, "daily");
    if (fs.existsSync(dailyDir)) {
      try {
        for (const entry of fs.readdirSync(dailyDir, {
          withFileTypes: true,
        })) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            files.push(path.join(dailyDir, entry.name));
          }
        }
      } catch {
        /* skip */
      }
    }

    return files;
  }
}
