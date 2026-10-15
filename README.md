# opencursor

A local-first desktop coding agent. Clean-room TypeScript implementation of agent
protocols observed in shipped desktop AI IDEs (tool-call unions, exec client/server
message loops, permission gating, session state) — built as a **Tauri v2 desktop GUI**
on a local Node agent server.

Not affiliated with any IDE vendor. Protocol type mirrors are clean-room TypeScript
translations of publicly observable message contracts for interoperability research;
no proprietary source code is included.

## Architecture

```
apps/desktop            Tauri v2 shell + React GUI
      │  HTTP RPC + SSE (127.0.0.1, ephemeral port)
packages/server         local agent server (runtime, SQLite, MCP, index)
      │
packages/core           protocol, tools, models, runtime, persistence, memory, index
```

| Package | Responsibility |
|---|---|
| `packages/core` | Protocol contracts, 21 tools, model clients (Anthropic/OpenAI/mock), agent runtime, SQLite persistence, memory, semantic index. Zero runtime dependencies. |
| `packages/server` | HTTP + SSE bridge exposing the runtime to the GUI. Owns the database, MCP connections, background shells, and the index. |
| `apps/desktop` | Tauri v2 shell (spawns and supervises the server) with a React GUI: chat, tool cards, permission dialogs, todos, sessions, memory, system panel. |

## Quick start

```sh
npm install
npm run build          # core + server
npm test               # 86 tests (unit + server end-to-end)
npm run desktop        # launch the desktop GUI (Tauri)
```

The desktop shell spawns the local server on an ephemeral port and connects to it
automatically. To run the parts separately:

```sh
npm run desktop:server              # server on :4180
npm --prefix apps/desktop run dev   # GUI dev server (Vite) — open http://localhost:5173/?port=4180
```

Without API keys the built-in mock model runs offline, so the full loop is
exercisable with no network.

## Requirements

- Node.js >= 20.11 (developed against 22.x)
- Rust toolchain (for the Tauri shell)
- Optional: `rg` (ripgrep) on `PATH` for fast search — set `OPENCURSOR_RIPGREP_PATH` to override

## Model providers

Provider selection order: `config.json` → `OPENCURSOR_PROVIDER` → key auto-detection → `mock`.

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic Messages API (streaming) |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI or any OpenAI-compatible endpoint |
| `OPENCURSOR_PROVIDER` | `anthropic` \| `openai` \| `mock` |
| `OPENCURSOR_MODEL` | Model id override |

## Tools

The agent has 21 tools: `read_file`, `write_file`, `str_replace`, `edit_file`,
`delete_file`, `grep_search`, `file_search`, `list_dir`, `run_terminal_cmd`,
`codebase_search`, `web_search`, `web_fetch`, `update_todos`, `read_todos`,
`create_plan`, `read_lints`, `task` (subagents), `ask_question`, `memory`, `mcp`,
`write_shell_stdin`, `read_shell_output`, `index`.

Mutating tools (`write_file`, `str_replace`, `edit_file`, `delete_file`,
`run_terminal_cmd`, `web_*`, `task`, `mcp` calls) are gated by the permission
engine before execution. Read-only tools run without prompting.

## Permissions

Three decision states mirror the observed protocol: **allow** (runs), **rejected**
(user denied — distinct from an error), and **permission_denied** (policy).

- `ask` mode (default): each gated call opens a dialog in the GUI. `allow_always`
  records a pattern rule (command prefix, directory, or URL origin) to
  `~/.opencursor/permissions.json`.
- `yolo` mode: everything auto-approves except hard-denied destructive commands
  (`rm -rf /`, `mkfs`, `dd of=/dev/…`, fork bombs).

## Hooks

PreToolUse / PostToolUse shell hooks intercept every tool call. Configure in
`~/.opencursor/config.json`:

```json
{
  "hooks": {
    "pre":  [{ "matcher": "run_terminal_cmd|write_file", "command": "node ./hooks/guard.cjs", "timeout_ms": 10000 }],
    "post": [{ "command": "node ./hooks/audit.cjs" }]
  }
}
```

The hook receives a JSON payload on stdin (`tool_name`, `tool_input`, `cwd`,
`session_id`; post hooks also `tool_output`, `duration_ms`) and decides via stdout
JSON (`{"decision":"allow"|"deny","reason":"…"}`) or exit code (`2` = deny, other
non-zero = error). `matcher` is `tool|tool`, `*`, or omitted for all tools.
Timeouts kill the whole process tree.

## MCP servers

```json
{
  "mcp_servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true
    }
  }
}
```

Servers connect at startup over stdio JSON-RPC. The model reaches them through the
`mcp` tool; the GUI System panel shows connection status and tools. On Windows,
`.cmd`/`.bat` launchers are spawned through the shell.

## Memory

Four write paths, all persisted to SQLite and mirrored to `memory.json` + `MEMORY.md`:

- **`memory` tool** — the model saves/searches/forgets entries
  (`fact`, `decision`, `preference`, `artifact`, `summary`, `note`)
- **Auto turn summaries** — completed tool-using turns are distilled into summaries
- **Artifact capture** — created/modified files are recorded
- **GUI Memory panel** — add and forget entries directly

The memory digest is injected into the system prompt each turn.

## Checkpoints & undo

Before every mutating tool call the previous file content is snapshotted to SQLite.
The GUI System panel restores the most recent checkpoint per file; files that did
not exist are removed on undo.

## Context compaction

Long conversations compact automatically (configurable via `context.max_chars`) or
on demand: older messages are archived to SQLite and replaced by a running summary
in the system prompt. The recent tail (`context.keep_recent`, default 6) stays
verbatim. Archived history is never lost.

## Semantic index

`codebase_search` uses a local embedding index when built:

- Chunker: overlapping line-window chunks (60 lines, 10 overlap, 4k char cap)
- Embeddings: local hashing provider by default (offline, zero deps), or
  `OPENCURSOR_EMBEDDINGS_PROVIDER=openai` with `text-embedding-3-small`
- Incremental: mtime/hash skip, deleted-file removal, provider-switch invalidation
- Storage: SQLite (`indexed_files`, `chunks` with Float32 blobs)

Build it from the GUI System panel or with the `index` tool.

## Sessions

Sessions persist to SQLite. The GUI sidebar lists recent sessions with message
counts; resume any of them, or start a new one. Summaries and todos survive reloads.

## Homebase

Everything lives under `~/.opencursor/` (override with `OPENCURSOR_HOME`):

| Path | Purpose |
|---|---|
| `config.json` | settings (provider, model, permissions, memory, MCP, hooks, context) |
| `opencursor.db` | SQLite: sessions, messages, ops, todos, memories, checkpoints, archives, index (+FTS5) |
| `memory.json` | JSON mirror of memories |
| `MEMORY.md` | human-readable digest injected into the system prompt |
| `permissions.json` | persisted `allow_always` rules |

SQLite uses the built-in `node:sqlite` driver (Node >= 22.5) — no native deps.

## Configuration reference

```json
{
  "version": 1,
  "provider": null,
  "model": null,
  "permission_mode": "ask",
  "max_iterations": 24,
  "memory": {
    "auto_summarize": true,
    "capture_artifacts": true,
    "max_digest_chars": 4000,
    "max_search_results": 8
  },
  "context": { "enabled": true, "max_chars": 60000, "keep_recent": 6 },
  "mcp_servers": {},
  "hooks": { "pre": [], "post": [] }
}
```

## Development

```sh
npm run build          # compile core + server
npm run typecheck      # type-check without emit
npm run lint           # eslint
npm test               # full suite
npm run desktop        # Tauri dev (spawns server automatically)
```

Layout:

```
packages/core/src/
  protocol/     frozen wire contracts (tools, session, models, events)
  tools/        one file per tool + registry
  models/       provider clients + SSE parser + mock
  runtime/      agent loop, subagent runner
  session/      SQLite + file + memory stores, checkpoints, archives
  permissions/  policy engine
  memory/       memory store + mirrors
  index/        embeddings, chunker, store, indexer
  hooks/        pre/post tool hooks
  mcp/          stdio JSON-RPC client + manager
  shells/       background shell registry
packages/server/src/
  main.ts       HTTP + SSE server, wiring
  rpc.ts        RPC methods
apps/desktop/src/
  App.tsx       GUI root
  ui/           components (transcript, tool cards, dialogs, panels)
  lib/          server client, transcript reducer
```

`CONTRACTS.md` documents the frozen interface layer and the delegation rules used
to build the core.

## License

MIT
