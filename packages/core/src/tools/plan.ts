/** create_plan + read_lints. */

import { spawn } from 'node:child_process';
import type { ToolHandlerFor } from '../types.js';
import type { CreatePlanArgs, LintSuccess, PlanSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';

export const createPlanTool: ToolHandlerFor<'create_plan'> = {
  name: 'create_plan',
  description:
    'Present a structured plan (markdown overview + todo list) before starting complex work. ' +
    'After approval, execute steps and keep todos updated.',
  input_schema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'Plan body in markdown' },
      name: { type: 'string', description: 'Short plan name' },
      overview: { type: 'string', description: 'One-paragraph overview' },
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['plan', 'todos'],
  },
  default_permission: 'allow',
  async execute(args: CreatePlanArgs, ctx) {
    const plan = args.plan.trim();
    const name = args.name?.trim() || 'Plan';
    const overview = args.overview?.trim() ?? '';
    if (plan.length === 0) return err('invalid_args', 'plan body is empty');
    if (!Array.isArray(args.todos)) return err('invalid_args', 'todos must be an array');

    const value: PlanSuccess = { plan, todos: args.todos, name, overview };
    ctx.plans?.set(value);
    if (ctx.todos) {
      ctx.todos.set(args.todos, false);
    }
    return ok(value);
  },
};

function runLintCommand(command: string, path: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(command, [path], { cwd, shell: true, windowsHide: true });
    let text = '';
    proc.stdout.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    const timer = setTimeout(() => proc.kill(), 30_000);
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(text);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

interface ParsedDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  range: { start_line: number; start_column: number; end_line: number; end_column: number };
}

function parseDiagnostics(output: string): ParsedDiagnostic[] {
  const diagnostics: ParsedDiagnostic[] = [];
  for (const line of output.split('\n')) {
    const match = /^(.*?):(\d+):(\d+):\s*(error|warning|info|hint)?:?\s*(.*)$/i.exec(line.trim());
    if (!match) continue;
    const [, , lineNo, colNo, severity, message] = match;
    if (lineNo === undefined || colNo === undefined || message === undefined) continue;
    const parsedLine = Number.parseInt(lineNo, 10);
    const parsedColumn = Number.parseInt(colNo, 10);
    diagnostics.push({
      severity: (severity?.toLowerCase() ?? 'error') as ParsedDiagnostic['severity'],
      message,
      range: {
        start_line: parsedLine,
        start_column: parsedColumn,
        end_line: parsedLine,
        end_column: parsedColumn + 1,
      },
    });
  }
  return diagnostics;
}

export const readLintsTool: ToolHandlerFor<'read_lints'> = {
  name: 'read_lints',
  description:
    'Read linter/compiler diagnostics for files. Requires OPENCURSOR_LINT_CMD on the host; otherwise returns empty diagnostics.',
  input_schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Files to lint' },
    },
    required: ['paths'],
  },
  default_permission: 'allow',
  async execute(args, ctx) {
    if (!Array.isArray(args.paths) || args.paths.length === 0) {
      return err('invalid_args', 'paths must be a non-empty array');
    }
    const command = process.env['OPENCURSOR_LINT_CMD'];
    const files: LintSuccess['files'] = [];
    for (const path of args.paths) {
      if (!command) {
        files.push({ path, diagnostics: [] });
        continue;
      }
      const output = await runLintCommand(command, path, ctx.cwd);
      files.push({ path, diagnostics: parseDiagnostics(output) });
    }
    if (!command) {
      ctx.onProgress?.('note', 'set OPENCURSOR_LINT_CMD to enable diagnostics');
    }
    const value: LintSuccess = { files };
    return ok(value);
  },
};
