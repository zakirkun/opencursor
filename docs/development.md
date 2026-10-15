# Development guide

## Prerequisites

- Node.js >= 20.11 (developed against 22.x — `node:sqlite` needs >= 22.5)
- Rust toolchain (stable) for the Tauri shell
- Optional: ripgrep (`rg`) on `PATH`

## Setup

```sh
npm install
npm --prefix apps/desktop install
```

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | compile `packages/core` + `packages/server` (tsc project refs) |
| `npm run typecheck` | type-check without emit |
| `npm run lint` | eslint over the whole repo |
| `npm test` | full suite (unit + server end-to-end) |
| `npm run desktop` | Tauri dev — spawns the server automatically |
| `npm run desktop:server` | run the server standalone on :4180 |
| `npm --prefix apps/desktop run dev` | GUI dev server (Vite) |
| `npm --prefix apps/desktop run tauri:build` | packaged desktop build |

## Testing philosophy

Tests are offline and deterministic. Unit tests drive the agent loop with scripted
in-test model clients (`ScriptedModel` in `packages/core/test/runtime.test.ts`), so
no network or API key is needed. Tests that need infrastructure use the real thing
against loopback:

- `packages/server/test/rpc.test.ts` spawns the actual server on an ephemeral port
  and drives it over HTTP + SSE against a local stub OpenAI-compatible provider.
- `packages/core/test/mcp.test.ts` spawns a fake MCP server as a child process.
- `packages/core/test/hooks.test.ts` runs real hook scripts.

Run a single file: `npx tsx --no-cache --test packages/core/test/runtime.test.ts`

Windows note: shell tests rely on the process-tree kill path (`taskkill /T /F`);
keep timeouts generous when debugging hangs.

## Project conventions

- ESM + NodeNext: relative imports **must** carry `.js` suffixes.
- `verbatimModuleSyntax`: use `import type` for type-only imports.
- `noUncheckedIndexedAccess`: index accesses yield `T | undefined` — code defensively.
- No `as any` / `@ts-ignore`; no new runtime dependencies in `core`.
- Tools return `ToolOutcome` via the `ok` / `err` / `rejected` helpers.
- Public interfaces carry doc comments; implementation stays self-documenting.

## Adding a tool

1. Create `packages/core/src/tools/<name>.ts` exporting a `ToolHandlerFor<'name'>`.
2. Add the name + args + result value to `packages/core/src/protocol/tools.ts`
   (the `ToolCall` union and `ToolResultValues`).
3. Register it in `packages/core/src/tools/index.ts`.
4. Add tests in `packages/core/test/`.
5. If it needs runtime services, extend `ToolContext` in `packages/core/src/types.ts`
   and wire it in the runtime's `makeContext`.

## Adding an RPC method

1. Implement it in `packages/server/src/rpc.ts` (throw `Error` for failures —
   the dispatcher converts them to `{error}` responses).
2. Add the GUI call in `apps/desktop/src/App.tsx` or a component.
3. Cover it in `packages/server/test/rpc.test.ts`.

## Database migrations

`packages/core/src/db/open.ts` holds the schema and the `migrate()` function.
Bump `SCHEMA_VERSION` and add guarded `ALTER TABLE` statements for existing
databases. Never drop columns destructively — the database is the user's session
history.

## Testing without network

There is no built-in mock provider. For UI work, point the server at a local stub
with any OpenAI-compatible shape:

```sh
OPENCURSOR_HOME=$(mktemp -d) \
OPENCURSOR_PROVIDER=openai OPENCURSOR_MODEL=stub-model-1 \
OPENAI_API_KEY=stub-key OPENAI_BASE_URL=http://127.0.0.1:9000/v1 \
node packages/server/dist/main.js
```

`packages/server/test/rpc.test.ts` contains a ready-made stub provider (models list
+ streaming chat completions) you can copy. `ScriptedModel` in
`packages/core/test/runtime.test.ts` is the pattern for unit tests: a hand-rolled
`ModelClient` that yields a fixed sequence of stream events.

## Debugging

- The server prints its bound port and a ready line; the Tauri shell forwards its
  stdout/stderr as `server-log` events (visible in the devtools console).
- `OPENCURSOR_HOME` isolates all state — point it at a temp dir for experiments.
- The GUI **Settings** tab shows the resolved model and provider status; the header
  displays a warning when no model is configured.
