# Advisor Implementation

## Overview

The `advisor` feature (gated by the `advisor` cargo feature) registers an `AdvisorTool` that the main agent can call when it needs strategic guidance. The advisor is either a **second LLM model** or a **human handoff** — whichever mode is configured.

When called, the advisor receives the full conversation transcript (truncated to a kilobyte budget), the agent's question, and returns advice as tool output visible to the main agent.

## Files

| File | Role |
|---|---|
| `src/extras/advisor/mod.rs` | `AdvisorTool` struct, `AdvisorToolConfig`, `init_config()`, `with_config()`, `update_client()`, human-handoff channel, `run_advisor_completion()`, `advisor_call()`, `format_conversation()` |
| `src/agent/builder.rs:269-273` | Registration: pushes `AdvisorTool` into the main agent's tool list |
| `src/main.rs:462-520` | Initialization: resolve config, create client, set up handoff channel, call `init_config()` |
| `src/cli.rs:226-264` | CLI flags: `--advisor`, `--advisor-model`, `--advisor-max-uses`, `--advisor-human-handoff`, `--advisor-kilobytes-limit` |
| `src/cli.rs:403-450` | Resolver methods merging CLI + file config |
| `src/config/types.rs:172-194` | `AdvisorConfig` struct |
| `src/config/mod.rs:208` | `Config.advisor: Option<AdvisorConfig>` |
| `src/ui/mod.rs:2507-2540` | TUI poll for human-handoff requests |
| `src/ui/mod.rs:2816-2872` | `handle_human_handoff()`: interactive input loop |
| `src/ui/mod.rs:475-476` | Session message sync before agent spawn |
| `src/ui/slash/settings.rs:54-191` | `/advisor` slash command (runtime settings) |

## Architecture

### Configuration

```
CLI flags (--advisor, --advisor-model, etc.)
    │
    ▼
Config file ([advisor] section) ──► merged by cli.rs resolver methods
    │
    ▼
AdvisorConfig { enabled, model, max_uses, human_handoff, advisor_kilobytes_limit }
    │
    ▼
main.rs: init AdvisorToolConfig → advisor::init_config() [global static Mutex<Option<AdvisorToolConfig>>]
```

### AdvisorToolConfig (global static)

```rust
pub struct AdvisorToolConfig {
    pub enabled: bool,
    pub model: CompactString,          // e.g. "deepseek-v4-pro"
    pub max_uses: Option<usize>,       // default Some(3)
    pub human_handoff: bool,
    pub client: Option<AnyClient>,     // None if disabled/failed
    pub advisor_kilobytes_limit: u32,  // default 256
    pub handoff_tx: Option<HandoffSender>,
}
```

### Client Resolution

1. Look up `advisor_model` in `quick_models_map()` to get the provider.
2. If the advisor provider matches the main provider, clone the existing `AnyClient`.
3. If different, create a second `AnyClient` with its own API key resolution.
4. On failure: warn, set `client: None`, disable advisor.

## Tool Implementation

### `AdvisorTool`

```rust
pub struct AdvisorTool {
    uses: AtomicUsize,  // track calls per request, capped by max_uses
}
```

Implements `rig::tool::Tool`:
- **Name**: `"advisor"`
- **Args**: `AdvisorArgs { question: String }`
- **Output**: `String`
- **Error**: `ToolError`

### Tool Description

Varies by mode:
- **Handoff mode**: "Consult the user for strategic guidance…"
- **Model mode**: "Consult an expert advisor model for strategic guidance. The advisor receives your full conversation transcript automatically…"

### `call()` — Two Branches

#### Branch A: Human Handoff

```
AdvisorTool::call(args)
  │
  ├─ Check handoff_tx exists (None in non-interactive → error)
  ├─ Create oneshot channel for reply
  ├─ handoff_tx.send(HandoffRequest { question, reply: reply_tx })
  │     │
  │     ▼
  │   TUI event loop polls handoff_rx.try_recv()
  │     │
  │     ▼
  │   handle_human_handoff():
  │     - Render "[handoff] Model requests your guidance:"
  │     - Show question indented
  │     - Prompt: "Type your response and press Enter (ESC to cancel)"
  │     - tokio::select! loop on UserEvent::Key:
  │       Enter → break with buffer
  │       Esc   → break with empty string (cancelled)
  │     - req.reply.send(response)
  │     │
  │     ▼
  ├─ Await reply_rx
  ├─ If BrokenPipe (Esc/cancel) → "Handoff cancelled"
  └─ Return user's text as tool result
```

#### Branch B: Model Advisor

```
AdvisorTool::call(args)
  │
  ├─ Clone SESSION_MESSAGES (global static synced before each agent spawn)
  ├─ cfg.client.completion_model(cfg.advisor_model) → AnyModel
  ├─ format_conversation(messages, kilobytes_limit)
  │     │
  │     └─ Split KB budget in half: head (oldest) + tail (newest)
  │        Walk from both ends accumulating "[Role]: content" lines
  │        If gap: insert "[... conversation omitted ...]"
  │
  ├─ Build prompt:
  │     "## Conversation\n{truncated}\n## Assistant's question\n{question}"
  │
  └─ advisor_call(model, prompt)
        │
        ├─ AgentBuilder(model)
        │     .preamble(ADVISOR_SYSTEM_PROMPT)
        │     .build()
        ├─ agent.stream_chat(prompt, []).multi_turn(1)
        ├─ Retry logic on stream errors
        ├─ Collect stream, extract FinalResponse
        └─ Return text (or "[Advisor returned empty response]")
```

### `ADVISOR_SYSTEM_PROMPT`

The advisor identifies itself as a strategic consultant for a coding assistant. It is told to give concise, actionable guidance based on the conversation transcript.

### `format_conversation()`

- Splits the kilobyte budget equally between head (oldest messages) and tail (newest).
- Walks from both ends, formatting each message as `[Role]: content`.
- Stops when each side's byte budget is exhausted.
- If the head and tail don't meet, inserts `[... conversation omitted ...]`.
- Ensures the advisor sees both early context and recent context without blowing the context window.

## Session Message Sync

Before each agent spawn, `SESSION_MESSAGES` (a global static) is updated with the current transcript. This happens in:
- `src/ui/mod.rs:475-476` (TUI)
- `src/ui/slash/mod.rs` (slash commands)
- `src/main.rs:856-859` (print/loop modes)

## Runtime `/advisor` Slash Command

The user can inspect and change advisor settings at runtime without restarting:

| Command | Effect |
|---|---|
| `/advisor` | Show current status |
| `/advisor on\|off` | Enable/disable |
| `/advisor handoff [on\|off]` | Toggle human handoff mode |
| `/advisor model <name>` | Change model (triggers `update_client()`) |
| `/advisor max-uses <n>` | Set call limit |
| `/advisor context-limit <kb>` | Set KB budget |

Each mutation calls `advisor::init_config(cfg)` to update the global static. Model/handoff changes also call `update_client()` to re-resolve the client.

## Registration

In `src/agent/builder.rs:269-273`, after core tools and MCP tools but before hooks wrapping:

```rust
#[cfg(feature = "advisor")]
if crate::extras::advisor::with_config(|c| c.enabled) {
    all_tools.push(Box::new(AdvisorTool::new()));
}
```

The tool is only registered if `enabled` is true — if disabled, the model cannot call it.
