# Tool reference

All tools return a `ToolOutcome` envelope:

```ts
type ToolOutcome<V> =
  | { kind: 'success'; value: V }
  | { kind: 'error'; code: ToolErrorCode; message: string }
  | { kind: 'rejected'; reason: string };
```

`rejected` means the user declined; `error` with code `permission_denied` means
policy blocked it. The model sees both distinctly.

## File operations

### read_file
Read a text file. Args: `path` (required), `offset` (1-based line), `limit`
(default/max 2000 lines), `include_line_numbers`. Binary files (NUL in first 4KB)
are rejected. Relative paths resolve against the workspace; escapes are denied.

### write_file
Create or overwrite a file, creating parent directories. Args: `path`,
`file_text`, `return_file_content_after_write`.

### str_replace
Exact literal replacement. Args: `path`, `old_text`, `new_text`. `old_text` must
match **exactly once** — zero matches and multiple matches are both errors with
specific messages.

### edit_file
Whole-file rewrite. Args: `path`, `stream_content` (complete new body). Returns a
computed unified diff (bounded LCS, ≤2000 lines) plus before/after content when
the file existed and is under 1MB.

### delete_file
Delete a regular file. Directories are rejected. Args: `path`.

## Search

### grep_search
ripgrep-backed content search. Args: `pattern`, `path?`, `glob?`, `output_mode?`
(`content` | `files_with_matches` | `count`), `context` / `context_before` /
`context_after`, `case_insensitive?`, `type?`, `head_limit?` (default 250),
`multiline?`, `offset?`. Parses `rg --json` for exact line/context data.

### file_search
Glob file discovery via `rg --files`. Args: `glob_pattern`, `target_directory?`.
Bounded to 5000 files.

### list_dir
Directory listing, directories first then alphabetical. Args: `path`, `ignore[]`.
Entries include size for files. Bounded to 2000 entries.

### codebase_search
Concept search. Uses the semantic index when built (embeddings + cosine ranking,
returns file paths with line-numbered snippets and scores); falls back to
multi-term keyword ranking when the index is empty. Args: `query`,
`target_directories?`, `explanation?`.

### index
Manage the semantic index. Args: `operation` (`status` | `run` | `clear`).

## Execution

### run_terminal_cmd
Run a shell command. Args: `command`, `working_directory?`, `timeout?` (default
120s, max 600s), `is_background?`, `description?`. Streams stdout/stderr as
`tool-progress` events. Non-zero exits are **successes** with `exit_code`; timeouts
and cancellations are errors. Background commands register with the shell registry
and return a shell id.

### write_shell_stdin
Send input to a background shell. Args: `shell_id`, `data?`, `close_stdin?`.

### read_shell_output
Read buffered output from a background shell. Args: `shell_id`, `drain?`.
Returns `running`, `exit_code`, `stdout`, `stderr`, and byte counts.

## Planning

### update_todos / read_todos
Maintain the session todo list. `update_todos` args: `todos[]` (each with
`content`, `status` ∈ pending/in_progress/completed/cancelled, optional `id`,
`priority`), `merge` (false = replace, true = upsert by id).

### create_plan
Present a structured plan before complex work. Args: `plan` (markdown),
`name`, `overview`, `todos[]`. Also seeds the todo list.

### read_lints
Read diagnostics for files. Args: `paths[]`. Requires `OPENCURSOR_LINT_CMD` on the
host; parses gcc/tsc-style `file:line:col: severity: message` output. Without the
env var it returns empty diagnostics and emits a note.

## Delegation & interaction

### task
Delegate to a subagent. Args: `description`, `prompt`, `subagent_type`
(`general` | `explore` | `shell`), `model?`. The child runs with a restricted
toolset and returns a summary. `explore` is read-only; `shell` is commands +
reads.

### ask_question
Ask the user 1–5 questions with optional options. Args: `title`, `questions[]`.
Blocks until answered. Use when requirements are genuinely ambiguous.

## Integration

### memory
Persistent memory. Args: `operation` (`add` | `search` | `list` | `forget`),
`text?`, `kind?` (fact/decision/preference/artifact/summary/note), `tags?`,
`id?`, `query?`, `limit?`.

### mcp
Use configured MCP servers. Args: `operation` (`list` | `call`), `server?`,
`tool?`, `arguments?`. `list` is auto-allowed; `call` is permission-gated.

### web_search / web_fetch
`web_search` requires `OPENCURSOR_SEARCH_URL` (POST `{query}` →
`{results:[{title,url,snippet}]}`). `web_fetch` retrieves a URL (15s timeout, 2MB
cap) and converts HTML to readable text/markdown.

## Permission defaults

| Default `ask` | Default `allow` |
|---|---|
| `run_terminal_cmd`, `write_file`, `str_replace`, `edit_file`, `delete_file`, `web_fetch`, `web_search`, `task`, `mcp` (call), `index` (run/clear) | everything else |

Safe shell commands (`ls`, `git status`, `rg`, version checks, …) are auto-allowed
in `ask` mode. Hard-denied patterns (`rm -rf /`, `mkfs`, `shutdown`, …) are blocked
even in `yolo` mode.
