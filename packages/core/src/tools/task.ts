/** task + ask_question — delegation and interactive question surfaces. */

import type { ToolHandlerFor } from '../types.js';
import type { AskQuestionSuccess, TaskSuccess } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';

export const taskTool: ToolHandlerFor<'task'> = {
  name: 'task',
  description:
    'Delegate a scoped job to a subagent (general | explore | shell). The subagent runs with a ' +
    'restricted toolset and returns a summary. Use for parallel exploration or long command sequences.',
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short 3-5 word description of the task' },
      prompt: { type: 'string', description: 'Full, self-contained instructions for the subagent' },
      subagent_type: { type: 'string', description: 'general | explore | shell' },
      model: { type: 'string', description: 'Optional model override' },
    },
    required: ['description', 'prompt', 'subagent_type'],
  },
  default_permission: 'ask',
  async execute(args, ctx) {
    if (!ctx.subagents) return err('internal', 'subagent runner not attached');
    if (!args.prompt || args.prompt.trim().length === 0) return err('invalid_args', 'prompt is empty');

    const profiles = ctx.subagent_profiles ?? {};
    const profile = profiles[args.subagent_type];
    if (!profile) {
      const available = Object.keys(profiles).join(', ') || 'none';
      return err('invalid_args', `unknown subagent_type '${args.subagent_type}'; available: ${available}`);
    }

    const result = await ctx.subagents.run(profile, args.prompt, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      parent_session_id: ctx.session_id,
    });
    if (result.kind === 'success') {
      const value: TaskSuccess = {
        summary: result.value.summary,
        subagent_type: args.subagent_type,
        conversation_id: result.value.conversation_id,
      };
      return ok(value);
    }
    return result;
  },
};

export const askQuestionTool: ToolHandlerFor<'ask_question'> = {
  name: 'ask_question',
  description:
    'Ask the user 1-5 questions with optional multiple-choice options. Blocks until answered. ' +
    'Use when requirements are ambiguous and proceeding would risk wrong work.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Title shown above the questions' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            header: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, description: { type: 'string' } },
                required: ['label'],
              },
            },
            multiple: { type: 'boolean' },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
  default_permission: 'allow',
  async execute(args, ctx) {
    if (!ctx.askUser) return err('internal', 'interactive surface not attached');
    if (!Array.isArray(args.questions) || args.questions.length === 0 || args.questions.length > 5) {
      return err('invalid_args', 'questions must contain 1-5 items');
    }
    for (const question of args.questions) {
      if (!question.question || question.question.trim().length === 0) {
        return err('invalid_args', 'question text is empty');
      }
      if (question.options && (question.options.length < 1 || question.options.length > 5)) {
        return err('invalid_args', 'each question may have 1-5 options');
      }
    }
    const answers = await ctx.askUser(args.questions);
    const value: AskQuestionSuccess = { answers, async_pending: false };
    return ok(value);
  },
};
