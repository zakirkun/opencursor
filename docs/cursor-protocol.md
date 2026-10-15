# Cursor observed protocol — clean-room reference

**Source:** Cursor `3.4.20` · commit `0cf8b06883f54e26bb4f0fb8647c9500ccb43310` · build `2026-05-15`
**Method:** REA static analysis of shipped JavaScript + direct artifact byte inspection. Static-only unless marked otherwise.
**Scope:** all 18 first-party `cursor-*` extensions under `resources/app/extensions/`.

> Clean-room note: everything below is a TypeScript re-description of publicly
> observable wire contracts, written for interoperability research. No
> proprietary source code is reproduced. This document is the **input spec** for
> opencursor; see `CONTRACTS.md` for what is frozen and what is left to build.

## 0. Target identity

| Item | Value |
|---|---|
| `Cursor.exe` | 211,042,088 bytes, PE32+, x86_64, ProductName `Cursor`, CompanyName `Anysphere` |
| SHA-256 | `7ebaee270a40f21dec50278fd2b83204b979d886cecd7e9d7479b6007d423a10` |
| Version | `3.4.20` (FileVersion + ProductVersion + `product.json`) |
| `product.json` | `urlProtocol: cursor`, `quality: stable`, repo pointer `microsoft/vscode` |
| Runtime | Stock Electron/Chromium shell. **No Cursor-specific native code.** |
| Product logic | `resources/app/out/` (VS Code fork) + 18 `cursor-*` extensions |

Native analysis is exhausted: the executable is an unmodified Electron
bootloader (53 standard PE resources — icons, version info, manifest; no
product logic). Everything meaningful is JavaScript.

## 1. Extension inventory

| Extension | JS size | Activation | Role |
|---|---:|---|---|
| `cursor-agent-exec` | 9.5 MB | `*` | Agent execution host: tool impls, proto types, canvas runtime, agent SDK |
| `cursor-retrieval` | 4.1 MB | `onStartupFinished` | Codebase index/retrieval (Merkle, grep, git history) |
| `cursor-always-local` | 3.5 MB | `onStartupFinished`, `onResolveRemoteAuthority:background-composer` | Local agent bridge; VM control-plane client |
| `cursor-mcp` | 2.6 MB | `onStartupFinished`, `onUri` | MCP servers, OAuth (patched SDK) |
| `cursor-resolver-helper` | 2.5 MB | `onResolveRemoteAuthority…`, `onStartupFinished` | TS resolver helpers |
| `cursor-commits` | 2.2 MB | `onStartupFinished` | Commit graph / history UI |
| `cursor-agent-worker` | 1.7 MB | `onStartupFinished` | Background agent worker host |
| `cursor-browser-automation` | 1.5 MB | `onStartupFinished` | Browser-use executor (screenshot/click/keyboard) |
| `cursor-shadow-workspace` | 1.0 MB | `onStartupFinished` | Shadow workspace + shadow server |
| `cursor-deeplink` | 0.7 MB | `onStartupFinished`, `onUri` | `cursor://` deeplinks |
| `cursor-polyfills-remote` | 0.1 MB | `*` | Remote polyfills |
| `cursor-socket` | 10 KB | `onResolveRemoteAuthority…` | Socket provider (fully readable) |
| `cursor-ndjson-ingest` | small | `onCommand:cursor.ndjsonIngest.*` | NDJSON trace ingestion (5 commands) |
| `cursor-checkout`, `cursor-explorer`, `cursor-file-service`, `cursor-resolver`, `cursor-worktree-textmate` | small | mixed | checkout flow, explorer UI, file service, resolver, worktree grammar |

## 2. The `agent.v1` protocol

**763 unique `agent.v1.*` types** (prior pass recorded 686 — a 77-type gap).

### 2.1 Exec wire protocol (exact field numbers)

`ExecServerMessage` (server → exec host) — `id(1)`, `exec_id(15)`, oneof `message`:

| # | Field | # | Field |
|---:|---|---:|---|
| 2 | `shell_args` | 18 | `read_mcp_resource_exec_args` |
| 3 | `write_args` | 20 | `fetch_args` |
| 4 | `delete_args` | 21 | `record_screen_args` |
| 5 | `grep_args` | 22 | `computer_use_args` |
| 7 | `read_args` | 23 | `write_shell_stdin_args` |
| 8 | `ls_args` | 27 | `execute_hook_args` |
| 9 | `diagnostics_args` | 28 | `subagent_args` |
| 10 | `request_context_args` | 30 | `force_background_shell_args` |
| 11 | `mcp_args` | 31 | `force_background_subagent_args` |
| 14 | `shell_stream_args` | 36 | `mcp_state_exec_args` |
| 16 | `background_shell_spawn_args` | 37 | `subagent_await_args` |
| 17 | `list_mcp_resources_exec_args` | 29 | `redacted_read_args` |
| 19 | `span_context` | | |

`ExecClientMessage` (exec host → server) mirrors it 1:1 with `*_result` /
`shell_stream` at the **same tag numbers**, plus `id(1)`, `exec_id(15)`.

Control channels:

```
ExecClientControlMessage { stream_close(1) | throw(2) | heartbeat(3) }   // host → server
ExecServerControlMessage { abort(1) }                                     // server → host
```

This is the loop to reproduce: **server sends typed args → host executes
locally → host streams typed results back → abort/heartbeat/stream_close out of
band.** 142 `*Args`/`*Result` types were recovered.

### 2.2 Tool union — 49 `ToolCall` variants

`AiAttribution, ApplyAgentDiff, AskQuestion, Await, BlameByFilePath,
CommunicateUpdate, ComputerUse, ConversationHistory, CreatePlan, Delete, Edit,
EditPrLabels, Fetch, GenerateImage, GetMcpTools, Glob, Grep, ListMcpResources,
Ls, Mcp, McpAuth, PrManagement, Read, ReadLints, ReadMcpResource, ReadTodos,
RecordCiInvestigationFindings, RecordScreen, Reflect, ReplaceEnv, ReportBug,
ReportBugfixResults, SemSearch, SendFinalSummary, SetActiveBranch,
SetupVmEnvironment, Shell, StartGrindExecution, StartGrindPlanning, SwitchMode,
Task, Truncated, UpdatePrCodeTour, UpdateTodos, WebFetch, WebSearch,
WriteShellStdin`

Model-facing name literals observed: `read_file`, `write_file`, `str_replace`,
`apply_patch`, `run_terminal_cmd`, `delete_file`, `web_search`, `web_fetch`,
`codebase_search`, `read_lints`, `grep_search`, `file_search`, `list_dir`,
`update_todos`, `read_todos`, `create_plan`, `task`, `ask_question`,
`switch_mode`, `sem_search`.

### 2.3 Error taxonomy — the rejected / denied / error triple

**Every** tool has its own error union. 58 `*Error` types recovered, including
`ReadError`, `WriteError`, `StrReplaceError`, `ShellSpawnError`, `GrepError`,
`DeleteError`, `EditError`, `TaskError`, `SubagentError`, `McpError`,
`SwitchModeError`, `CreatePlanError`, `AskQuestionError`, `CanvasRegisterError`.

A conforming implementation must model **three distinct states** per tool:

| State | Meaning |
|---|---|
| `rejected` | user vetoed the call |
| `permission_denied` | policy refused it |
| `error` | execution failed (not-found, invalid, timeout, …) |

### 2.4 Sandbox policy (fully decoded)

```
SandboxPolicy {
  type(1): enum                  // 0 UNSPECIFIED | 1 INSECURE_NONE
                                 // 2 WORKSPACE_READWRITE | 3 WORKSPACE_READONLY
  network_access(2): bool?
  additional_readwrite_paths(3): string[]
  additional_readonly_paths(4): string[]
  debug_output_dir(5): string?
  disable_tmp_write(7): bool?
  allowlist_escalated(8): bool?
  enable_shared_build_cache(9): bool?
  network_policy(10): message?
  network_policy_strict(11): bool?
  capture_denies(12): bool?
  skip_statsig_defaults(13): bool?
}
```

Telemetry/decision literals: `sandbox_policy`, `requested_sandbox_policy`,
`effective_sandbox_policy`, `sandbox_enabled`, `sandbox_supports`,
`suggested_sandbox_mode`, `sandbox_default_network_allowlist`,
`sandbox_network_explicit_allowlist`, `sandbox_denies`, `sandbox_git`.
Embedded per-tool (`grep`, `ls`) and passed to exec.

### 2.5 Modes

```
AgentMode:  AGENT_MODE_UNSPECIFIED | AGENT_MODE_AGENT | AGENT_MODE_ASK
          | AGENT_MODE_DEBUG | AGENT_MODE_MULTITASK | AGENT_MODE_PLAN
          | AGENT_MODE_PROJECT | AGENT_MODE_TRIAGE

TaskMode:   TASK_MODE_UNSPECIFIED | TASK_MODE_AGENT | TASK_MODE_PLAN

SubagentEnvironment: SUBAGENT_EXECUTION_ENVIRONMENT_{UNSPECIFIED,LOCAL,CLOUD}
```

Seven agent modes vs. opencursor's two. `switch_mode` is a tool-call variant.

### 2.6 Hooks

```
PreToolUseRequestQuery   { tool_name, tool_input, tool_use_id, cwd?, conversation_id?, generation_id?, model? }
PostToolUseRequestQuery  { …same…, tool_output, duration_ms }
PostToolUseFailureRequestQuery   // failure path
PreCompactRequestQuery           // fires before context compaction
```

### 2.7 Subagents

11 types: `Unspecified, Bash, BrowserUse, ComputerUse, CursorGuide, Custom,
Debug, Explore, MediaReview, Shell, VmSetupHelper, WatchVideo`.

`SubagentArgs` carries `tool_call_id, subagent_type, model_id, prompt, readonly,
resume_agent_id?, run_in_background?, continuation_config,
parent_conversation_id?, {api_key|azure|bedrock}_credentials, interrupt?, mode,
fork_agent_id?, root_parent_conversation_id?, selected_context?,
direct_meta_parent_child_subagent?, environment, cloud_base_branch?`.

Custom subagents (`agent.v1.CustomSubagent`) add plugin/marketplace provenance:
`full_path, name, description, tools, model, prompt, plugin, marketplace,
plugin_id, marketplace_id`.

### 2.8 Skills (subsystem absent from the prior report)

`agent.v1.AgentSkill`, `AgentSkillMetadata{full_path, description, parse_error,
environments, disabled_environments, git_remote_origin, disable_model_invocation,
plugin, marketplace, plugin_id, marketplace_id, globs}`.

Wire literals: `agent_skills`, `available_skills`, `selected_skills`,
`skill_options`, `skill_id`, `skill_names`, `skill_descriptors`,
`recently_used_skill_ids`, `inline_skills`, `omitted_skills`, `skill_source`,
`vm_provisioned_skills`, `agent_skills_batch_update`,
`agents_md_and_skills`.

### 2.9 Streaming updates (14)

`TextDeltaUpdate, ThinkingDeltaUpdate, ThinkingCompletedUpdate,
ToolCallDeltaUpdate, ToolCallStartedUpdate, ToolCallCompletedUpdate,
TokenDeltaUpdate, UserMessageAppendedUpdate, StepStartedUpdate,
StepCompletedUpdate, SummaryStartedUpdate, SummaryCompletedUpdate,
TurnEndedUpdate, ShellOutputDeltaUpdate`

### 2.10 Conversation state

`ConversationAction` oneof: `user_message_action, resume_action, cancel_action,
summarize_action, shell_command_action, start_plan_action, execute_plan_action,
async_ask_question_completion_action, cancel_subagent_action,
background_task_completion_action`.

`ConversationStateStructure`: `root_prompt_messages_json[]`, `turns[]`,
`todos[]`, `pending_tool_calls[]`, `token_details`, `summary`, `plan`,
`previous_workspace_uris[]`, `mode`, `summary_archive(s)`,
`file_states map<string,bytes>`, `file_states_v2`, `turn_timings`.

`AgentRunRequest`: `conversation_state(1)`, `action(2)`, `model_details(3)`,
`requested_model(9)`, `mcp_tools(4)`, `conversation_id(5)`,
`mcp_file_system_options(6)`, `skill_options(7)`, `custom_system_prompt(8)`,
`suggest_next_prompt(10)`, `subagent_type_name(11)`,
`exclude_workspace_context(12)`, `harness(13)`, `selected_subagent_models(14)`,
`selected_subagent_model_details(15)`, `conversation_group_id(16)`,
`pre_fetched_blobs(17)`, `dev_raw_model_slug(18)`,
`client_supports_inline_images(19)`, `subagent_model_overrides(20)`,
`can_create_cloud_subagents(21)`, `suppress_subagent_progress_update_tool(22)`.

## 3. Canvas SDK — the portable UI spec

Shipped as readable `.d.ts` under
`cursor-agent-exec/dist/agent-sdk/cursor/canvas/`. This is the last
unimplemented item in the opencursor blueprint.

### 3.1 Hooks

```ts
useHostTheme(): CanvasHostTheme      // { kind, tokens, palette } + flat token groups
useCanvasState<T>(key, defaultValue): [T, SetCanvasState<T>]   // persisted to .canvas.data.json
useCanvasAction(): (action: CanvasAction) => void              // fire-and-forget
```

`CanvasAction` observed: `{ type: "openAgent", agentId }` — `agentId` is the
conversation UUID (filename stem in `agent-transcripts/`).

### 3.2 Tokens

Stable inline-style paths (dark values shown; light palette is parallel):

| Path | Dark |
|---|---|
| `text.primary` | `#E4E4E4EB` |
| `text.secondary` | `#E4E4E48D` |
| `text.tertiary` | `#E4E4E45E` |
| `text.quaternary` | `#E4E4E442` |
| `text.link` | `#87c3ff` |
| `text.onAccent` | `#191c22` |
| `bg.editor` | `#181818` |
| `bg.chrome` | `#141414` |
| `bg.elevated` | `#181818` |
| `fill.primary…quaternary` | `#E4E4E430 / 1E / 11 / 0A` |
| `stroke.primary/secondary/tertiary` | `#E4E4E433 / 1F / 14` |
| `accent.primary` | `#599CE7` |
| `accent.control` | `#599CE7` |
| `accent.controlHover` | `#6AABE9` |
| `diff.insertedLine` | `#3FA26633` |
| `diff.removedLine` | `#B8004933` |
| `diff.stripAdded` | `#3FA2668F` |
| `diff.stripRemoved` | `#FC6B838F` |

Light palette base `#141414` on `editor #FCFCFC` / `chrome #F8F8F8` /
`sidebar #F3F3F3`; accent `#3685BF`.

Shared 7-hue category palette (`colorPalette`): `gray #8888A8E0`,
`purple #7B64B8F0`, `green #1F8A65E8`, `yellow #E8C030E0`, `pink #C85898E0`,
`blue #2E79B5E0`, `orange #F0A040E0`.

Typography: `h1 24/30 w590`, `h2 18/24 w590`, `h3 16/22 w590`,
`body 14/20 w400`, `small 12/16 w400`.

Spacing scale (px): `0.5:2, 1:4, 1.5:6, 2:8, 2.5:10, 3:12, 3.5:14, 4:16,
4.5:18, 5:20, 6:24, 7:28, 8:32, 9:36, 10:40`.

Radius (px): `none 0, xs 2, sm 4, md 6, lg 8, xl 12, full 9999`.

### 3.3 Components

**Layout / typography / surfaces:** `Stack{children,gap,style}`,
`Row{children,gap,align,justify,wrap,style}`,
`Grid{children,columns:number|string,gap,align,style}`, `Divider{style}`,
`Spacer()`, `Text{children,tone,size,as,weight,italic,truncate,style}`,
`H1/H2/H3{children,style}`, `Code{children,style}`, `Link{children,href,style}`,
`Card{children,variant:default|borderless,size:base|lg,stickyHeader,collapsible,
defaultOpen,open,onOpenChange,style}`, `CardHeader{children,trailing,style}`,
`CardBody{children,style}`, `mergeStyle(base,override?)`, `CanvasChevron{expanded}`.

**Actions / feedback:** `Button{children,variant:primary|secondary|ghost,disabled,
type,style,onClick}` (24px tall, never full-width),
`Pill{children,active,tone:neutral|added|deleted|renamed|success|warning|info,
size:sm|md,leadingContent,keyboardHint,disabled,title,style,onClick}`,
`Stat{value,label,tone:success|danger|warning|info,style}`,
`Callout{children,tone:info|success|warning|danger|neutral,title,icon,style}`,
`IconButton{children,onClick,disabled,title,variant:default|circle,size:sm|md,style}`.

**Tables:** `Table{headers,rows,columnAlign,rowTone:success|danger|warning|info|
neutral,framed,striped,stickyHeader,style,emptyMessage}`.

**Forms:** `TextInput{value,onChange:(v:string)=>void,placeholder,disabled,type,
style}`, `TextArea{…,rows}`, `Checkbox{checked,onChange:(v:boolean)=>void,disabled,
label,style}`, `Toggle{checked,onChange,disabled,size:sm|md,style}`,
`Select{value,onChange,options:SelectOption[],placeholder,disabled,style}`.
All `onChange` callbacks receive the **value directly**, not a DOM event.

**Charts:** `BarChart{categories,series,height,stacked,horizontal,normalized,
valueSuffix,style}`, `LineChart{categories,series,height,fill,valueSuffix,style}`,
`PieChart{data,size,donut,style}` with
`ChartSeries{name,data:number[],tone?:ChartTone}` and
`ChartTone = success|danger|warning|info|neutral`.

**Diff:** `DiffView{lines:DiffLineData[],path?,language?,showLineNumbers?,
coloredLineNumbers?,showAccentStrip?,style}` with
`DiffLineData{type:added|removed|unchanged,content,lineNumber?}`;
`DiffStats{additions?,deletions?,style?}`.

**Disclosure:** `CollapsibleSection{title,leading,count,trailing,children,style}`
(borderless, starts closed); `Card collapsible` for bordered.

**Todo:** `TodoList{todos,dimmedTodoIds?,onTodoClick?,style}`,
`TodoListCard{todos,dimmedTodoIds?,defaultExpanded?,onTodoClick?,style}`,
`TodoItem{id,content,status:pending|in_progress|completed|cancelled}`.

**Usage:** `UsageBar{segments:UsageBarSegment[],total,topLeftLabel,
topRightLabel,style}`, `UsageBarSegment{id,value,color?:Color}`;
`Swatch{color:Color,style}`.

**DAG:** `computeDAGLayout({nodes,edges,direction,nodeWidth,nodeHeight,rankGap,
nodeGap,padding}) → {nodes,edges,ranks,direction,width,height}` with back-edge
detection via DFS.

### 3.4 Design constraints (encoded in the shipped docs)

- Colors from `useHostTheme()` tokens only — **no hardcoded hex**.
- **No gradients, no box-shadows.**
- Don't wrap every section in `Card`; mix open sections with cards.
- `CardHeader` takes plain text only (no headings, buttons, or layout rows).
- `H1`/`H2` never inside `CardHeader`.
- Never nest cards inside cards — use `Divider`.
- Don't wrap `Table` in a `Card` unless the card is a named entity.
- Buttons are always inline, never stretched to full width.
- Run a pre-delivery self-check before returning code.

## 4. Canvas host protocol

```
CanvasRegisterArgs  { path }          → CanvasRegisterResult { CanvasRegisterSuccess{canvas_id} | CanvasRegisterError{error} }
CanvasDestroyArgs   { canvas_id }     → CanvasDestroyResult {}
CanvasGetUrlArgs    ?                 → CanvasGetUrlResult ?
```

## 5. MCP integration

- Ships patched `@modelcontextprotocol/sdk@1.25.1`.
- Transient-error classifier for OAuth refresh; sibling refresh coordination:
  `prepareForRefresh`, `releaseRefreshLeaseOnError`, `SiblingAlreadyRefreshedError`.
- Policy literal `mcp_oauth_refresh_policy` drives fallthrough.
- OAuth refresh lock protos: `McpOAuthRefreshLock{Begin,Release}`,
  `StoreMcpOAuthToken`, `ValidateMcpOAuthTokens`, `ProbeMcpUrl`,
  `McpServerMetadata`, `MCPKnownServerInfo`.
- MCP tools surface **through the agent tool union** as `mcp_tool_call`.
- Exec-side MCP: `McpArgs`, `McpAuthArgs`, `McpStateExecArgs`,
  `ListMcpResourcesExecArgs`, `ReadMcpResourceExecArgs`.

## 6. Retrieval / index

`cursor-retrieval` (3.74 MB JS + 19.9 MB native `file_service.win32-x64-msvc.node`):

- Merkle sync: `SyncMerkleSubtree{V2}{Request,Response}` — local hash tree,
  diff against server tree, only changed subtrees re-uploaded.
- `RegisterFileToIndex{Request,Response}`, `SemanticSearchFullParams`,
  `IsolatedTreesitterResponse.TreesitterSymbolNameItem`.
- Native exports: `MerkleClient`, `CodebaseSnapshotClient`, `GrepClient`,
  `GitClient`, `GitGraph`, `DiffClient`, `LocalBugbotContext`,
  `InEditorContentSource`, `runGitHistoryCycle`, `commitChainGetFiles`,
  `GeneratePackfileStatus`, `MULTI_ROOT_ABSOLUTE_PATH`.
- Ignore files: `.cursorignore`, `.cursorindexingignore`.
- Repository sync states: `Syncing/Uploading/Synced/TooBig/NotFound/AuthTokenNotFound`.

## 7. Transport & endpoints

**Local agent bridge (resolves prior open unknown #2):** `cursor-always-local`
talks to a **local VM-manager over HTTP** — `managerUrl: http://localhost:50051`
— using `@bufbuild/protobuf` (ConnectRPC/protobuf), **not** ConnectRPC-over-WebSocket.

Cluster map (24 `managerUrl` entries): local `http://localhost:50051`; `dev`,
`test1`, `test2-gcp`, `train1–7`, `eval1`, `eval2`, `us1/us1p`, `us3/us3p`,
`us4/us4p`, `us5/us5p`, `us6/us6p`, `us7/us7p` at `*.cursorvm-manager.com`.
Dev cluster carries `httpProxyUrl: 10.0.29.128:8080`.

Other endpoints: `https://api2.cursor.sh`, `https://api3.cursor.sh`
(+ telemetry `api3.cursor.sh/tev1/v1`), updates `api2.cursor.sh/updates`,
`cursor.com`, MCP OAuth callback `www.cursor.com/agents/mcp/oauth/callback`.

Cloud control plane `anyrun.v1` (pods, devcontainers, egress policy, snapshots)
is cloud-only; client contracts only, server behavior opaque.

Model slugs (client-side): `composer-1.5`, `composer-2`, `composer-2-fast`,
`claude-4.5-*`, `claude-4.6-*` (`claude-code`, `claude-code-tutor` variants),
`gpt-5*`, `gemini-2.5-flash`, `gemini-3(-flash/-pro)`, `gemini-3.1-pro`,
`gpt-image-1`.

BYOK endpoints present in-binary: `https://api.anthropic.com/v1`,
`https://api.openai.com/v1`. Credential oneof: `ApiKeyCredentials{api_key,
base_url}`, `AzureCredentials{api_key,base_url,…}`, `BedrockCredentials`.

Env-var protocol surface: `CURSOR_AGENT`, `CURSOR_SANDBOX`, `CURSOR_ASKPASS`,
`CURSOR_ASKPASS_SECRET`, `CURSOR_ASKPASS_SOCKET`, `CURSOR_RIPGREP_PATH`,
`CURSOR_STATE_INPUT_FILE/OUTPUT_FILE`, `CURSOR_BASH_STATE_{START,END}__`,
`CURSOR_SNAP_EOF_`, `CURSOR_AGENT_LOCAL_REQUEST_LOG(_HTML)`,
`CURSOR_PREDICTION_SOURCE_*`, `CURSOR_RULE_SOURCE_*`, `CURSOR_RULES`,
`CURSOR_PROJECT`, `CURSOR_PERSONAL`, `CURSOR_PLUGIN_ROOT`, `CURSOR_DATA_DIR`,
`CURSOR_API_BASE_URL`.

## 8. Satellite behaviors

| Extension | Observed |
|---|---|
| `cursor-shadow-workspace` | `shadow`, `shadowServer`, `shadowHealthCheck`, `exclude`, `ignore` — shadow server mirrors edits |
| `cursor-browser-automation` | `screenshot`, `Click`, `keyboard` — browser-use executor |
| `cursor-socket` | `registerSocketConnectionProvider`, `onDidReceiveData`, `onDidClose`, `CursorSocketTransient`, `injectFailure` |
| `cursor-commits` | `commitHash`, `commitHistory`, `commitMessage`, `commitNotes`, `commitSha`, `Blame`, `branch` |
| `cursor-ndjson-ingest` | commands `cursor.ndjsonIngest.start`, `.reassignPort` |

## 9. Evidence ledger

| Evidence | Operation | Coverage | Key facts |
|---|---|---|---|
| `ev_6d1c3b72264791439f632b935546d505b4aa9bc1f35615aab1d154a8ec58fb5d` | `inspect_pe_resources` on `Cursor.exe` | complete | 53 resources, PE32+, x86_64, no product logic |
| `ev_879972806cbe064824278d054a1ab9ed118dcfdda49760fd23456d58f09ffe78` (+view `ev_37adfb0603f6c24d7ade88e1d16ba9c80ee67feb2ab96372dfb21b10b8639998`) | `analyze_javascript_application` on `cursor-agent-exec` | **partial** (cancelled; 38 files, 15 parsed, 132,013 AST nodes, 215 findings, 10 modules, 156 semantic + 23 application unknowns) | module inventory, canvas-runtime cancellation |

All string/schema extractions in §2–§8 were performed by **direct byte
inspection of the shipped artifact** (no REA evidence ID) and are observations
of shipped bytes, not executions.

### Limitations

- No runtime execution, no debugger, no network capture — static only.
- `cursor-agent-exec/dist/main.js` (8 MB) and
  `cursor-agent-exec/dist/canvas-runtime/canvas-runtime.esm.js` (1.5 MB) were
  **never fully analyzed**; REA cancelled both on the analysis budget. Their
  control flow is unverified; only the extracted schemas/literals above are
  observations.
- `cursor-retrieval/dist/main.js` and `file_service.*.node` are not analyzed in
  this pass (native analysis needs Ghidra/IDA, neither configured).
- Minified single-line webpack bundles; module ids are build-local.
- Server-side behavior (`aiserver.v1`, `anyrun.v1`) is inferred from client
  contracts only.

### Resolved unknowns (vs. the previous pass)

1. **Local exec transport** — resolved: HTTP ConnectRPC/protobuf to
   `http://localhost:50051` (`@bufbuild/protobuf`), not WebSocket.
2. **Agent mode set** — resolved: 7 `AgentMode` values.
3. **Sandbox policy shape** — resolved: full field list + 4 levels.
4. **Canvas SDK** — resolved: complete typed API surface.
5. **Skills subsystem** — discovered (absent from the prior report).

### Open unknowns (ranked, with next probes)

1. **Agent loop control flow** in `cursor-agent-exec/main.js` — which module
   drives `AgentRunRequest`/stream consumption. Probe: recover sources with
   Wakaru on Linux, then analyze per module; or raise `max_heap_mb` and run
   without the MCP transport timeout.
2. **Retrieval chunker ABI** — `tree-chunk-napi` params. Probe: Ghidra/IDA on
   the `.node`, or analyze `cursor-retrieval/worker/dist/main.js` (230 KB).
3. **Shadow-workspace copy-back policy** — ignore rules and apply semantics.
   Probe: analyze `cursor-shadow-workspace/dist/extension.js` with a larger heap.
4. **Prompt composition** — `root_prompt_messages_json` is composed
   server-side; the client sends only `custom_system_prompt`. Probe: controlled
   replay of a live session (outside static analysis).
5. **`.canvas.data.json` schema/versioning** — probe: inspect a real sidecar
   from a user data dir.

---

*Generated from REA static evidence + direct artifact inspection. Corrections
welcome where a probe resolves the open unknowns.*
