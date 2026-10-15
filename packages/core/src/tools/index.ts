/** Tool registry — aggregates the builtin tool handlers. */

import type { AnyToolHandler, ToolRegistry } from '../types.js';
import type { ModelToolDef, ToolName } from '../protocol/tools.js';
import { readFileTool } from './read.js';
import { writeFileTool } from './write.js';
import { strReplaceTool } from './str_replace.js';
import { editFileTool } from './edit.js';
import { deleteFileTool } from './delete.js';
import { grepSearchTool } from './grep.js';
import { fileSearchTool } from './glob.js';
import { listDirTool } from './ls.js';
import { shellTool } from './shell.js';
import { codebaseSearchTool } from './codebase_search.js';
import { webSearchTool, webFetchTool } from './web.js';
import { updateTodosTool, readTodosTool } from './todos.js';
import { createPlanTool, readLintsTool } from './plan.js';
import { taskTool, askQuestionTool, subagentAwaitTool, subagentCancelTool } from './task.js';
import { switchModeTool } from './switch_mode.js';
import { memoryTool } from './memory.js';
import { createMcpTool } from './mcp.js';
import { writeShellStdinTool, readShellOutputTool } from './shell_stdin.js';
import { indexTool } from './semantic_index.js';
import type { McpManager } from '../mcp/manager.js';

const BUILTIN: AnyToolHandler[] = [
  readFileTool,
  writeFileTool,
  strReplaceTool,
  editFileTool,
  deleteFileTool,
  grepSearchTool,
  fileSearchTool,
  listDirTool,
  shellTool,
  codebaseSearchTool,
  webSearchTool,
  webFetchTool,
  updateTodosTool,
  readTodosTool,
  createPlanTool,
  readLintsTool,
  taskTool,
  subagentAwaitTool,
  subagentCancelTool,
  switchModeTool,
  askQuestionTool,
  memoryTool,
  writeShellStdinTool,
  readShellOutputTool,
  indexTool,
];

export function createRegistry(handlers: AnyToolHandler[]): ToolRegistry {
  const byName = new Map<string, AnyToolHandler>();
  for (const handler of handlers) byName.set(handler.name, handler);
  return {
    get(name: ToolName): AnyToolHandler | undefined {
      return byName.get(name);
    },
    list(): AnyToolHandler[] {
      return [...byName.values()];
    },
    modelTools(): ModelToolDef[] {
      return [...byName.values()].map((handler) => ({
        name: handler.name,
        description: handler.description,
        input_schema: handler.input_schema,
      }));
    },
  };
}

export function createBuiltinRegistry(opts?: { mcp?: McpManager }): ToolRegistry {
  const handlers = [...BUILTIN];
  if (opts?.mcp) handlers.push(createMcpTool(opts.mcp));
  return createRegistry(handlers);
}
