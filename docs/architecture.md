# Architecture

opencursor is three layers with strict dependency direction:

```
apps/desktop  ──HTTP+SSE──▶  packages/server  ──imports──▶  packages/core
```

`core` never imports `server` or `desktop`. `server` never imports `desktop`.

## packages/core

Zero runtime dependencies (Node built-ins + global `fetch` only). Everything the
agent needs to run headlessly:

### protocol/

The frozen wire contracts. These mirror publicly observable message shapes from
shipped desktop AI IDEs for interoperability research — they are clean-room
TypeScript translations, not copied source.

| File | Contents |
|---|---|
| `tools.ts` | Tool arg schemas, result values, the `ToolCall` union, the `ToolOutcome` envelope (`success` / `error` / `rejected`) |
| `session.ts` | `SessionState`, message union (user/assistant/tool), todos, usage, conversation summaries, checkpoint info |
| `models.ts` | `ModelClient` interface, `ModelStreamEvent` union, provider config, defaults |
| `events.ts` | `AgentEvent` union consumed by the GUI (turn lifecycle, deltas, tool progress, permissions, hooks, compaction, undo) |

The `ToolOutcome` envelope is load-bearing: **user rejection and policy denial are
distinct states from errors**, matching the observed protocol. Every tool returns
exactly one of the three.

### tools/

One file per tool, all conforming to `ToolHandlerFor<K>`: `name`, `description`,
`input_schema` (JSON Schema for the provider wire), `default_permission`, and
`execute(args, ctx)`. The registry (`tools/index.ts`) aggregates them;
`createBuiltinRegistry({ mcp })` optionally adds the MCP tool.

`ToolContext` carries what tools need from the runtime: `cwd`, `session_id`,
`signal`, `onProgress`, `askUser`, `subagents`, `todos`, `plans`, `memory`,
`shells`, `indexer`, `subagent_profiles`.

### models/

Provider clients implementing `ModelClient.generate()` as an async iterable of
`ModelStreamEvent`. The SSE parser (`sse.ts`) is dependency-free and handles chunk
boundaries splitting any byte sequence, CRLF, comments, and multi-line data.

- `anthropic.ts` — Messages API, streaming, tool-use blocks
- `openai.ts` — Chat Completions, streaming, `tool_calls` deltas, reasoning fields
- `mock.ts` — deterministic offline model (scripted tool calls for demos/tests)
- `index.ts` — `createModelClient`, `detectModelConfig`

### runtime/

The agent loop (`runtime.ts`):

1. Append the user message, emit `turn-started`.
2. Loop up to `max_iterations`:
   - Build the system prompt (identity + cwd + tool list + conversation summary + memory digest)
   - Stream the model; emit text/reasoning deltas; collect tool calls
   - If no tool calls and stop reason ≠ `tool_use`, end the turn
   - For each call: capture a checkpoint (mutating tools) → pre-hook → permission
     precheck → interactive ask → execute → post-hook → emit completion
   - Append the tool-result message; repeat
3. Emit `turn-ended`, persist the session.

`createSubagentRunner` (`subagents.ts`) runs child runtimes with allow-listed tool
subsets (`general`, `explore`, `shell`), in-memory sessions, and isolated shell
registries that are killed when the child finishes.

### session/

- `sqlite.ts` — the source of truth. Sessions, messages, ops, todos, summaries.
- `store.ts` — file-based store (JSON + ndjson) for environments without SQLite
- `memory.ts` — in-memory store for subagent children
- `checkpoints.ts` — pre-edit file snapshots for undo
- `archives.ts` — full message history preserved across compaction

### Other subsystems

- `permissions/policy.ts` — hard denies, safe-command allowlist, persisted `allow_always` rules
- `memory/store.ts` — memories in SQLite + FTS5, mirrored to JSON and Markdown
- `index/` — embeddings providers, chunker, SQLite index store, incremental indexer
- `hooks/runner.ts` — PreToolUse/PostToolUse shell hooks with process-tree kill on timeout
- `mcp/` — stdio JSON-RPC client (initialize/list/call) + multi-server manager
- `shells/registry.ts` — background shells with stdin writes and buffered output
- `db/open.ts` — SQLite schema + migrations (currently v3)

## packages/server

A small HTTP server bound to `127.0.0.1` on an ephemeral port (prints
`OPENCURSOR_SERVER_PORT=<n>` on stdout for the shell to read).

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness + cwd + session id |
| `GET /api/events` | SSE stream: agent events, permission requests, question requests |
| `POST /api/rpc` | `{id, method, params}` → `{id, result}` or `{id, error}` |

RPC methods (see `rpc.ts`): `status`, `session.list/load/new/state`,
`chat.send/abort`, `permission.respond`, `question.respond`, `todos`,
`memory.list/add/forget`, `index.status/run/clear`, `mcp.status`,
`checkpoints.list/undo`, `context.compact`, `file.read`.

The server owns every stateful resource (DB handle, MCP connections, shells,
indexer) and exposes them through one `ServerContext` object. It shuts down
cleanly on SIGINT/SIGTERM: kills shells, closes MCP servers, drains SSE clients,
closes the DB.

## apps/desktop

Tauri v2 shell + React GUI.

The Rust side (`src-tauri/src/lib.rs`) has one job: spawn the server
(`node packages/server/dist/main.js --port 0`), read its port from stdout, stream
its logs to the webview via `server-log` events, and kill it when the window is
destroyed. Commands: `start_server`, `stop_server`, `server_port`.

The React side:

- `main.tsx` — resolves the port (query param → Tauri `start_server` → fallback) and mounts
- `lib/client.ts` — typed RPC client + SSE subscription
- `lib/transcript.ts` — folds server events into renderable items (pure reducer)
- `ui/` — transcript, tool cards, permission/question dialogs, side panel, primitives
- `ui/theme.ts` — semantic design tokens (text/bg/fill/stroke/accent/diff/status)

The GUI never talks to the database directly; every read and write goes through
the server RPC surface.
