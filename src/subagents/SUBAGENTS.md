# Task-Based Subagent Implementation

## Overview

The `subagents` feature (always compiled, gated by `task_enabled` config) provides a `task` tool that spawns multiple **read-only, parallel, independent LLM agents** for code investigation. Each subagent has its own model, a restricted tool palette, and a 300-second timeout. Results are collected, truncated, combined into Markdown, and returned to the main agent as a single synthesized tool output.

## Files

| File | Role |
|---|---|
| `src/extras/subagents/mod.rs` | Global mutable state: `SubagentConfig`, `init()`, event sender |
| `src/extras/subagents/builder.rs` | `build_explore_agent()`: constructs `AnyAgent` for each subagent |
| `src/extras/subagents/prompt.rs` | `EXPLORE_PROMPT` system prompt (concise code investigation persona) |
| `src/extras/subagents/task_tool.rs` | `TaskTool`: parsing, permission check, parallel spawn, result collection, truncation, combining |
| `src/agent/builder.rs:230-233` | Registration of `TaskTool` into the main agent's tool set |
| `src/agent/runner.rs:331-332` | Registers main agent's `event_tx` as global subagent event sender |
| `src/agent/runner.rs:785-841` | `run_subagent()`: silent execution loop collecting final text |
| `src/provider.rs:673-708` | `AnyAgent::run_subagent()`: enum-dispatch to `runner::run_subagent` |

## Initialization (`main.rs:347-406`)

1. **Model resolution**: `subagent_model` config → quick-model lookup → `subagent_provider` + model → fall back to main model/provider.
2. A separate `AnyClient` is created for the subagent provider (may differ from main; default `deepseek-v4-pro` uses OpenRouter). Falls back to main client silently on failure.
3. `subagents::init(client, model_name, max_turns, config, architecture)` stores configuration in a global `Mutex<Option<SubagentConfig>>`.
4. On each main agent spawn, the global subagent event sender is updated with the current agent's channel so subagent tool-call notifications flow to the TUI.

## The `task` Tool (`task_tool.rs`)

### Input

```json
{"prompts": ["prompt1", "prompt2", ...]}
```

One string for a single subagent; multiple strings for parallel independent investigations.

### Permission Check

`check_perm()` — same dual-layer glob+regex + doom-loop detection as other tools. The joined prompt texts are shown to the user for approval.

### Subagent Construction (`builder.rs`)

For each prompt, a subagent is built with:

- **System prompt**: `EXPLORE_PROMPT` — a concise code-investigation persona. Optionally extended with `ARCHITECTURE.md` contents and memory tool descriptions.
- **Tools**: `ReadTool`, `GrepTool`, `FindFilesTool`, `ListDirTool`, plus (if `memory` feature) `MemoryRead` and `MemorySearch`.
- **No** `WriteTool`, `EditTool`, `BashTool`, `TaskTool`, or shell access — subagents are **read-only**.
- **Limits from config**:

| Config key | Default | Applies to |
|---|---|---|
| `subagent_max_read_lines` | 2000 | `ReadTool` |
| `subagent_max_grep_results` | 200 | `GrepTool` |
| `subagent_max_find_results` | 200 | `FindFilesTool` |
| `subagent_max_list_dir_entries` | None (unlimited) | `ListDirTool` |
| `task_max_turns` | 20 | Max LLM turns per subagent |

- Built via `build_explore_agent()` which matches on `AnyModel` variants to construct the correct `AnyAgent` enum variant.

### Parallel Execution

```rust
for (i, prompt_text) in args.prompts.iter().enumerate() {
    let join_handle = tokio::spawn(async move {
        // 1. Optional hooks: dispatch_subagent_start("explore")
        // 2. Build explore agent
        // 3. tokio::time::timeout(300s, agent.run_subagent(...))
        // 4. Optional hooks: dispatch_subagent_stop("explore", false)
        //    If SubagentStopGate::Continue{reason}, re-run with extended prompt
        // 5. Return (index, prompt, Result<response, error_string>)
    });
    abort_handles.push(join_handle.abort_handle());
    handles.push(join_handle);
}
```

**Concurrency properties**:
- All prompts spawn **simultaneously** via `tokio::spawn` — no sequential bottleneck.
- Each subagent has a **300-second wall-clock timeout** via `tokio::time::timeout`. On timeout: `[timeout: subagent exceeded 300s]`.
- **Abort guard**: `SubagentGuard` holds all `AbortHandle`s. If the parent `call()` future is dropped (user cancels, session exits, parent agent stops), `Drop::drop` calls `.abort()` on every handle, preventing leaked tasks.
- Results collected via `futures::future::join_all`, then sorted by original prompt index.

### `run_subagent()` (`runner.rs:785-841`)

A silent execution loop (no stdout/stderr):

1. Calls `agent.stream_chat(prompt, []).multi_turn(max_turns)` through the retry system.
2. Iterates the stream: accumulates text tokens into `full_response`.
3. On **tool calls**: emits `AgentEvent::SubagentToolCall` to the main agent's event channel so the TUI renders `⌥ <tool>` lines (color `C_TOOL`, visually distinct from main agent's `◈` prefix).
4. On `FinalResponse`: captures response text.
5. On error: returns `anyhow::Error`.
6. If response is empty: returns an error.

### Result Processing & Combining

1. **Truncation**: each subagent response capped at **128 KiB** via `truncate_cjk()` (multi-byte-safe) with a `…[subagent response truncated at 131072B]` marker.
2. **Error/timeout**: propagated as `[error: ...]` or `[timeout: subagent exceeded 300s]`.
3. **Panic**: caught via `JoinError` from `join_all`, mapped to `[task panicked: ...]`.
4. **Combining** (`combine_results`):
   - Single prompt → raw response (no heading).
   - Multiple prompts → each gets `## Task N: <first 60 chars of prompt>` heading, separated by blank lines.
   - Trailing newline ensured.

### Event Reporting

During execution, subagent tool calls emit `AgentEvent::SubagentToolCall`. The TUI event handler renders these as `⌥ <tool summary>` (color `C_TOOL`), visually distinct from the main agent's `◈` prefix. The session stores these as `MessageRole::SubagentToolCall`.

## Hook Integration (feature `hooks`)

- **Pre-start**: `dispatch_subagent_start("explore")` returns optional `extra` text prepended to the prompt.
- **Post-stop**: `dispatch_subagent_stop("explore", false)` returns a `SubagentStopGate`. If `Continue { reason }`, the subagent is re-invoked with the previous response + the reason, giving the hook a chance to force additional investigation. The re-run also has the 300s timeout.

## Registration

In `src/agent/builder.rs:230-233`, gated on `task_enabled` config:

```rust
#[cfg(feature = "subagents")]
if crate::extras::subagents::with_config(|c| c.config.task_enabled) {
    all_tools.push(Box::new(TaskTool::new()));
}
```
