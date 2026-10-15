/** switch_mode — agent <-> plan mode transitions. */

import type { ToolHandlerFor } from '../types.js';
import type { SwitchModeSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';

export const switchModeTool: ToolHandlerFor<'switch_mode'> = {
  name: 'switch_mode',
  description:
    'Switch between agent and plan mode. Plan mode is read-only: file mutation, shell execution, ' +
    'delegation, and MCP are disabled so you can research and present a plan for review.',
  input_schema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['agent', 'plan'], description: 'Target mode' },
      explanation: { type: 'string', description: 'One-line reason shown to the user' },
    },
    required: ['mode'],
  },
  default_permission: 'allow',
  async execute(args, ctx) {
    if (args.mode !== 'agent' && args.mode !== 'plan') {
      return err('invalid_args', `mode must be 'agent' or 'plan'`);
    }
    if (!ctx.mode) return err('internal', 'mode accessor not attached');
    const value: SwitchModeSuccess = ctx.mode.set(args.mode, args.explanation);
    return ok(value);
  },
};
