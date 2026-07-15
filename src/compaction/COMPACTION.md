# Compaction Implementation

## Overview

Session compaction prevents context-window overflow by summarizing old messages via an LLM call, dropping the originals, and injecting the summary as a recap message. This is triggered automatically between turns, optionally mid-turn under memory pressure, or manually via `/compress`.

## Files

| File | Role |
|---|---|
| `src/session/mod.rs` | `Compaction` struct, `Session::compress()`, `needs_compaction()`, `select_compaction_cut()`, `compacted_context()`, `effective_context_tokens()` |
| `src/config/mod.rs` | `compact_enabled` (master switch), `mid_turn_compact_threshold` (opt-in mid-turn trigger) |
| `src/agent/prompt.rs` | `COMPACTION_PROMPT` — the summarizer system prompt template |
| `src/provider.rs` | `compress_messages()` — calls the LLM to produce the summary; `serialize_conversation()`; `summarize_with_model()` |
| `src/agent/runner.rs` | `convert_history()` — re-emits the compaction summary as an Assistant message when rebuilding history |
| `src/ui/slash/mod.rs` | `handle_compress()` — the shared compaction engine used by all trigger paths |
| `src/ui/slash/features.rs` | `/compress` slash command |
| `src/ui/event_handler.rs` | Between-turn trigger: calls `needs_compaction()` + `handle_compress()` after each agent turn |
| `src/ui/mod.rs` | Mid-turn trigger: `mid_turn_compact_and_respawn()`, `stop_turn_context_exhausted()` |
| `src/extras/memory/mod.rs` | `flush_compaction_summary()` — persists summary to daily log before compaction |
| `src/ui/statusline.rs` | Status bar item: `cmp:N` |

## The `Compaction` Struct

```rust
pub struct Compaction {
    pub summary: CompactString,        // LLM-generated summary text
    pub first_kept_index: usize,       // always 1 after compression (summary at index 0)
    pub summarized_count: usize,       // number of messages dropped
    pub token_savings: u64,            // estimated tokens freed
    pub created_at: CompactString,     // ISO 8601 timestamp
}
```

`Session` holds `compactions: Vec<Compaction>` — a history of all compactions in this session.

## Trigger Paths

### 1. Between-Turn Auto-Compaction

After every agent turn completes, in `src/ui/event_handler.rs:505-520`:

```rust
if cfg.resolve_compact_enabled()
    && session.needs_compaction(reserve)
    && !cli.no_session
{
    handle_compress(None, true, ...).await;
}
```

The gate is `needs_compaction(reserve_tokens)`:

```rust
pub fn needs_compaction(&self, reserve_tokens: u64) -> bool {
    if self.context_window == 0 { return false; }
    self.effective_context_tokens() > self.context_window.saturating_sub(reserve_tokens)
}
```

- `effective_context_tokens()` returns the calibrated token count if a calibration anchor exists; otherwise falls back to estimated tokens.
- `reserve_tokens` includes the LLM response budget plus (if `memory` feature) the injected memory block's token estimate via `effective_reserve()`.

### 2. Mid-Turn Auto-Compaction ("PR H")

Gated by `mid_turn_compact_threshold` (config value 0.0–1.0, **disabled by default**). When the agent emits a `CompletionCall` event, the handler computes prompt pressure:

```rust
let pressure = real_input_tokens as f64 / session.context_window as f64;
if pressure > threshold { ... }
```

If above threshold:
1. **Abort** the in-flight run (no tool calls have executed yet — safe to cancel).
2. Record the turn's partial progress as a recap `Assistant` message.
3. Call `handle_compress()` (same engine).
4. **Respawn** the agent with `MID_TURN_CONTINUE_PROMPT`:
   ```
   [Context was compacted to save space; the full prior history is in the system summary above.]
   Continue with the user's original task. Do not redo work already completed per the summary...
   ```

**Fail-safe** (`stop_turn_context_exhausted`): if after compaction the prompt is *still* over the ceiling (irreducible floor: system prompt + tool schemas + kept-recent messages + reserve), the turn stops with a diagnostic report.

### 3. Manual `/compress` or `/compact`

Slash command that calls `handle_compress()` with `auto=false`. This **skips the budget gate** — the user's explicit intent is honored regardless of fill level.

## Compaction Engine: `handle_compress()`

Located in `src/ui/slash/mod.rs:356`:

```
handle_compress(label, auto, session, config, client)
  │
  ├─ Compute reserve_tokens and keep_recent from config
  ├─ select_compaction_cut(messages, keep_recent)
  │     │
  │     └─ Walk backward through messages, accumulating estimated_tokens
  │        until keep_recent budget is covered. Returns index into messages.
  │        Returns 0 if everything fits within keep_recent → nothing to do.
  │
  ├─ If cut == 0 → early return (nothing to compress)
  │
  ├─ client.compress_messages()
  │     │
  │     ├─ serialize_conversation(messages[..cut_idx])
  │     │     └─ Format: "[User]: content\n[Assistant]: content\n..."
  │     ├─ Fill COMPACTION_PROMPT template:
  │     │     {conversation}   ← serialized old messages
  │     │     {previous_summary} ← last compaction's summary (for iterative context)
  │     │     {instructions}
  │     └─ Spawn separate LLM call:
  │           - Preamble: "You are a conversation summarizer."
  │           - Temperature: 0
  │           - No tools
  │           - Pure completion → return summary string
  │
  ├─ memory::flush_compaction_summary()  [if memory feature]
  │     └─ Persist summary to daily log BEFORE compress() so it survives deterministically
  │
  └─ session.compress(summary, cut_idx, token_savings)
        │
        ├─ Create System-role SessionMessage with summary text
        ├─ Drain messages[..first_kept_index] (the old messages)
        ├─ Insert summary at index 0
        ├─ Recompute total_estimated_tokens from remaining messages
        ├─ Push Compaction record to self.compactions
        └─ Reset calibration anchor (no longer valid after reindexing)
```

### `select_compaction_cut()`

Walks backward through messages accumulating per-message `estimated_tokens` (character-count-based heuristic) until the `keep_recent` budget is covered. Returns the index where `messages[..cut]` get summarized and `messages[cut..]` are kept.

**Design note**: Uses character estimates, not calibrated provider tokens. Since it's a *relative* comparison among messages, any uniform estimator bias cancels out. Calibration only matters for the absolute total in `effective_context_tokens`.

### `Session::compress()`

```rust
pub fn compress(&mut self, summary: String, first_kept_index: usize, token_savings: u64)
```

1. Creates a `System`-role `SessionMessage` with the summary text.
2. Drains `messages[..first_kept_index]`.
3. Inserts the summary at index 0.
4. Recomputes `total_estimated_tokens`.
5. Pushes a new `Compaction` record.
6. Resets calibration (anchor no longer lines up after reindexing).
7. Flushes to memory (if feature enabled): writes summary to daily log *before* `compress` so it survives compaction.

## History Reconstruction: `convert_history()`

In `src/agent/runner.rs:142`, when building history for the next request:

1. Calls `session.compacted_context()` which finds the `System` message matching the last compaction's summary — returns `(Some(summary_text), index_of_next_message)`.
2. Emits the summary as an **Assistant**-role message (not System!), prefixed with:
   ```
   [Recap of my prior work in this conversation]
   ```

**Why Assistant not System**: Some model chat templates (e.g. Qwen 3.x) reject System messages past position 0. Assistant role also produces clean User↔Assistant alternation — it reads as "the agent recaps what it did, then the user continues."
