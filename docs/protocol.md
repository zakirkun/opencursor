# Protocol contracts

`packages/core/src/protocol/` is the frozen interface layer. These are clean-room
TypeScript translations of publicly observable message contracts from shipped
desktop AI IDEs, used for interoperability research. They are not copied source.

Everything in this directory is **stable**: tools, runtime, server, and GUI all
compile against it. Changes ripple everywhere — treat modifications as breaking.

## The outcome envelope

```ts
type ToolOutcome<V> =
  | { kind: 'success'; value: V }
  | { kind: 'error'; code: ToolErrorCode; message: string }
  | { kind: 'rejected'; reason: string };
```

Three states, deliberately distinct:

| State | Meaning | Who produced it |
|---|---|---|
| `success` | the tool ran and produced a value | tool |
| `error` | the tool failed (`invalid_args`, `not_found`, `permission_denied`, `timeout`, `cancelled`, `busy`, `internal`) | tool / policy |
| `rejected` | the **user** declined to run it | permission surface |

The model sees `rejected` and `error(permission_denied)` as different outcomes, so
it can react correctly (ask again vs. work around policy).

## Tool call union

`ToolCall` is a discriminated union of 22 call shapes, each
`{ id, tool, args }`. `ToolResultValues` maps every tool name to its success value
type, so `ToolCallResult` is a distributive union the GUI can switch on.

Arg schemas mirror the observed fields closely (`ReadArgs` has `offset`/`limit`/
`include_line_numbers`, `ShellArgs` has `working_directory`/`timeout`/
`is_background`, `GrepArgs` has context/type/head_limit, and so on).

## Session model

```ts
SessionState {
  version: 1
  id, created_at, updated_at, cwd
  model: { provider, id }
  messages: (UserMessage | AssistantMessage | ToolResultMessage)[]
  todos: TodoItem[]
  usage: { input_tokens, output_tokens }
  summary?: { text, archived_message_count, created_at }
}
```

- `AssistantMessage.tool_calls` records each call **with its outcome and duration**
  once executed — the transcript is reconstructable from the session alone.
- `ToolResultMessage` groups the outcomes fed back to the model in one turn step.
- `summary` is the compaction artifact; `archived_message_count` tracks how much
  history sits in `message_archives`.

## Model stream events

```ts
ModelStreamEvent =
  | { type: 'text-delta'; text }
  | { type: 'reasoning-delta'; text }
  | { type: 'tool-call'; call: ModelToolCall }
  | { type: 'usage'; usage: Partial<TokenUsage> }
  | { type: 'stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error' }
```

Every provider client normalizes into exactly this sequence. Tool-call args arrive
as raw JSON fragments on the wire; clients reassemble per call id and **throw on
malformed JSON** rather than emitting a partial call.

## Agent events

`AgentEvent` is the GUI-facing stream (single consumer, async iterable):

| Event | When |
|---|---|
| `turn-started` | user message appended |
| `step-started` / `step-completed` | model iteration boundaries |
| `text-delta` / `reasoning-delta` | streaming tokens |
| `tool-call-started` / `tool-progress` / `tool-call-completed` | tool lifecycle |
| `permission-requested` / `permission-resolved` | approval flow |
| `hook-result` | a pre/post hook denied or errored |
| `checkpoint-created` | pre-edit snapshot taken |
| `todos-updated` | todo list changed |
| `compacted` | conversation compacted |
| `undo-completed` | files restored |
| `turn-ended` | summary with `reason` (`end_turn`, `max_iterations`, `aborted`, `error`) |
| `error` / `notice` | out-of-band messages |

The server forwards these verbatim over SSE as `{type:'agent-event', event}`.
Permission and question requests travel as separate SSE message types with request
ids the GUI answers via RPC.

## Frozen helpers

`ok(value)`, `err(code, message)`, `rejected(reason)` construct outcomes. Tools
must use these rather than hand-building objects.
