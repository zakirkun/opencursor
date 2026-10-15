/** write_shell_stdin — send input to a background shell started by run_terminal_cmd. */

import type { ToolHandlerFor } from '../types.js';
import type {
  ReadShellOutputArgs,
  ReadShellOutputSuccess,
  WriteShellStdinArgs,
  WriteShellStdinSuccess,
} from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';

export const writeShellStdinTool: ToolHandlerFor<'write_shell_stdin'> = {
  name: 'write_shell_stdin',
  description:
    'Write to the stdin of a background shell (started with run_terminal_cmd is_background). ' +
    'Set close_stdin to send EOF. Read the shell output through subsequent run_terminal_cmd calls.',
  input_schema: {
    type: 'object',
    properties: {
      shell_id: { type: 'string', description: 'Background shell id' },
      data: { type: 'string', description: 'Text to write to stdin' },
      close_stdin: { type: 'boolean', description: 'Close stdin after writing (EOF)' },
    },
    required: ['shell_id'],
  },
  default_permission: 'ask',
  async execute(args: WriteShellStdinArgs, ctx) {
    if (!ctx.shells) return err('internal', 'shell registry not attached');
    if (!args.shell_id || args.shell_id.trim().length === 0) {
      return err('invalid_args', 'shell_id is required');
    }
    const data = args.data ?? '';
    try {
      const result = ctx.shells.write(args.shell_id, data, args.close_stdin === true);
      const value: WriteShellStdinSuccess = {
        shell_id: args.shell_id,
        bytes_written: result.bytes_written,
        closed: result.closed,
      };
      return ok(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('unknown shell')) return err('not_found', message);
      return err('internal', message);
    }
  },
};

export const readShellOutputTool: ToolHandlerFor<'read_shell_output'> = {
  name: 'read_shell_output',
  description:
    'Read buffered stdout/stderr from a background shell. Set drain to clear the buffers after reading. ' +
    'Use this to poll long-running processes started with run_terminal_cmd is_background.',
  input_schema: {
    type: 'object',
    properties: {
      shell_id: { type: 'string', description: 'Background shell id' },
      drain: { type: 'boolean', description: 'Clear buffers after reading' },
    },
    required: ['shell_id'],
  },
  default_permission: 'allow',
  async execute(args: ReadShellOutputArgs, ctx) {
    if (!ctx.shells) return err('internal', 'shell registry not attached');
    if (!args.shell_id || args.shell_id.trim().length === 0) {
      return err('invalid_args', 'shell_id is required');
    }
    try {
      const snapshot = ctx.shells.read(args.shell_id, args.drain === true);
      const value: ReadShellOutputSuccess = {
        shell_id: snapshot.shell_id,
        running: snapshot.running,
        exit_code: snapshot.exit_code,
        stdout: snapshot.stdout,
        stderr: snapshot.stderr,
        stdout_bytes: snapshot.stdout_bytes,
        stderr_bytes: snapshot.stderr_bytes,
      };
      return ok(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('unknown shell')) return err('not_found', message);
      return err('internal', message);
    }
  },
};
