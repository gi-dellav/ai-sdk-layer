# File Operation Tools: edit, find_files, grep

## Overview

Three tools for file manipulation and search. All use the standard permission system (dual-layer glob+regex rules, doom-loop detection). File paths are resolved relative to the working directory. Output is capped at configurable `max_results` limits with truncation notices.

## Files

| File | Lines | Role |
|---|---|---|
| `src/agent/tools/edit.rs` | 618 | The `edit` tool: SEARCH/REPLACE blocks (similarity mode) or tag-based line references (hashedit mode) |
| `src/agent/tools/find_files.rs` | 133 | The `find_files` tool: filename regex search with .gitignore support |
| `src/agent/tools/grep.rs` | 268 | The `grep` tool: content regex search with context lines and .gitignore support |

---

## `edit` Tool

**Name**: `"edit"`

**Description**: Varies by `EditSystem` (global, switched via `/editsys`):

- **Similarity mode**: `"Edit a file using aider-style SEARCH/REPLACE blocks. Each block finds exact text and replaces it. Multiple blocks in one call are applied atomically. If the search text is not an exact match, whitespace normalization and fuzzy matching are attempted as fallbacks."`
- **Hashedit mode**: `"Edit a file using tag-based line references. Copy tagged lines from read output. Edit is CAS-guarded via file-level CRC-32 hash. All edits in one call are applied atomically."`

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | `String` | Yes | Path to the file (relative or absolute) |
| `block` | `Option<String>` | No (similarity) | One or more `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks |
| `file_crc` | `Option<String>` | No (hashedit) | 8-char hex CRC-32 from the `read` output header |
| `edits` | `Option<Vec<EditOp>>` | No (hashedit) | Array of edit operations, each with `line`, `lines`, and `text` |

`EditOp` structure:
- `line`: single-line tagged copy (format: `N|XXXXXXXX content`)
- `lines`: multi-line tagged copy (format: `N|XXXXXXXX content` to `M|YYYYYYYY content`)
- `text`: replacement text (empty = delete)

### Permission Check

`check_perm_path(&self.permission, &self.ask_tx, "edit", &path)` — path-based (not pattern-based).

### Similarity Mode: Three-Tier Matching

1. **Exact match** — `content.find(search)`. If multiple exact matches exist, returns an error listing all match locations and asks for more context.
2. **Whitespace-normalized match** — collapses all whitespace sequences to a single space in both content and search, finds the normalized substring, then maps byte offsets back from normalized space to original content via `compute_byte_range()` (handling tabs→4 spaces and CRLF→LF).
3. **Fuzzy line-level match** — slides a window of search lines over content lines, computes Levenshtein similarity (`levenshtein_similarity`) on normalized text:
   - ≥85% → applies the edit
   - 60–84% → reports the closest match for user confirmation
   - <60% → reports "not found"

### Hashedit Mode

1. **File-level CRC-32 guard**: validates `file_crc` matches the CRC-32 of the current file contents before applying any edit — prevents edits on stale files.
2. **Line-level tag validation**: each tagged line (`N|XXXXXXXX content`) is validated: the 8-char hex tag must match `crc32_hex(actual_line.as_bytes())` for the given line number. Mismatch means the file changed — re-read required.
3. Supports both single-line (`line`) and multi-line range (`lines`) edits.

### Atomic Application

Edits are sorted by byte position in reverse order (largest first) and applied last-to-first so earlier byte offsets remain valid. CRLF line endings are preserved if the original file had them. Writes via `crate::fs::atomic_write` and calls `untrack_read_path` so the read-tracking system knows the file was modified (allowing re-reads).

---

## `find_files` Tool

**Name**: `"find_files"`

**Description**: `"Recursively find files matching a regex pattern in their filename. Respects .gitignore. Skips node_modules and target."`

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `pattern` | `String` | Yes | Regex pattern to match file names against (Rust regex syntax) |
| `path` | `Option<String>` | No | Directory to search in (defaults to cwd) |

### Permission Check

`check_perm(&self.permission, &self.ask_tx, "find_files", &args.pattern)` — pattern-based.

### Implementation Details

- **Uses `ignore` crate** (`WalkBuilder`): full `.gitignore` support (`.gitignore`, global gitignore, `.git/exclude`). Does not require a git repo (`require_git(false)`). Shows hidden files/dirs.
- **Directory filtering**: `is_skip_dir()` skips `node_modules` and `target` only.
- **Result capping**: respects `self.max_results`. Once the limit is hit, iteration stops immediately. Results sorted alphabetically after collection.
- **No binary/size filtering** — only checks `is_file()`.
- **Output format**: `"3 files found:\nfoo.rs\nbar.rs\nbaz.rs"`. If truncated: `"N files found (showing first M):\n...\n[truncated after M entries — K more; narrow the pattern or path]"`.
- **Error handling**: invalid regex patterns caught and returned as `ToolError::Msg`.

---

## `grep` Tool

**Name**: `"grep"`

**Description**: `"Search file contents using a regex pattern (Rust regex syntax). Respects .gitignore. Skips binary files, node_modules, and target."`

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `pattern` | `String` | Yes | Regex pattern to search for (Rust regex syntax) |
| `path` | `Option<String>` | No | Directory to search in (defaults to cwd) |
| `include` | `Option<String>` | No | File glob pattern to filter filenames (e.g. `*.rs`, `*.{ts,tsx}`) |
| `context_lines` | `Option<usize>` | No | Number of context lines before/after each match (like `grep -C`) |

### Permission Check

`check_perm(&self.permission, &self.ask_tx, "grep", &args.pattern)` — pattern-based.

### Implementation Details

- **`glob_to_regex` helper**: converts shell-style globs (`.`, `*`, `?`, `{a,b}`) into Rust regex patterns for the `include` filter.
- **Binary detection**: checks first 8192 bytes for null bytes (`b == 0`). Binary files silently skipped.
- **Size filter**: files larger than 10 MiB skipped.
- **Uses `ignore` crate**: same `.gitignore`-aware walking as `find_files`. Skips `node_modules` and `target`. Does not require a git repo.
- **Context mode** (when `context_lines > 0`):
  - Merges overlapping context windows via a `shown: Vec<bool>` array per file.
  - Match lines use `:` separator; non-match context lines use `-` separator.
  - Blocks separated by `--`.
- **No-context mode**: classic `path:line:text` format, one per match.
- **Result capping**: caps at `self.max_results`. Truncation note: `"[truncated after N matches — K more matches; narrow the pattern or restrict to a path]"`.
- **Task hint**: when ≥10 matches across ≥2 files (not truncated), appends a hint steering the agent toward the `task` subagent tool for cross-file synthesis.
