/** update_todos + read_todos — session todo list mutations. */

import { randomUUID } from 'node:crypto';
import type { ToolHandlerFor } from '../types.js';
import type { TodoItem } from '../protocol/session.js';
import type { ReadTodosArgs, TodosSuccess, UpdateTodosArgs } from '../protocol/tools.js';
import { err, ok } from '../protocol/tools.js';

const VALID_STATUS = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

function validateTodos(todos: unknown): todos is TodoItem[] {
  if (!Array.isArray(todos)) return false;
  return todos.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const record = item as Record<string, unknown>;
    return (
      typeof record['content'] === 'string' &&
      record['content'].length > 0 &&
      typeof record['status'] === 'string' &&
      VALID_STATUS.has(record['status']) &&
      (record['id'] === undefined || typeof record['id'] === 'string')
    );
  });
}

export const updateTodosTool: ToolHandlerFor<'update_todos'> = {
  name: 'update_todos',
  description:
    'Update the session todo list. merge=false replaces the list; merge=true upserts by id. ' +
    'Keep exactly one item in_progress while working.',
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['content', 'status'],
        },
      },
      merge: { type: 'boolean', description: 'true = upsert by id, false = replace list' },
    },
    required: ['todos'],
  },
  default_permission: 'allow',
  async execute(args: UpdateTodosArgs, ctx) {
    if (!ctx.todos) return err('internal', 'todo store not attached');
    if (!validateTodos(args.todos)) return err('invalid_args', 'invalid todo items');

    const incoming = args.todos.map((todo) => ({ ...todo, id: todo.id ?? randomUUID() }));
    const next = args.merge ? mergeTodos(ctx.todos.get(), incoming) : incoming;
    ctx.todos.set(next, false);
    const value: TodosSuccess = { todos: next };
    return ok(value);
  },
};

function mergeTodos(current: TodoItem[], incoming: TodoItem[]): TodoItem[] {
  const byId = new Map(current.map((todo) => [todo.id, todo]));
  const order: string[] = current.map((todo) => todo.id);
  for (const todo of incoming) {
    if (!byId.has(todo.id)) order.push(todo.id);
    byId.set(todo.id, { ...byId.get(todo.id), ...todo });
  }
  return order.map((id) => byId.get(id)).filter((todo): todo is TodoItem => todo !== undefined);
}

export const readTodosTool: ToolHandlerFor<'read_todos'> = {
  name: 'read_todos',
  description: 'Read the current session todo list.',
  input_schema: { type: 'object', properties: {} },
  default_permission: 'allow',
  async execute(_args: ReadTodosArgs, ctx) {
    if (!ctx.todos) return err('internal', 'todo store not attached');
    const value: TodosSuccess = { todos: ctx.todos.get() };
    return ok(value);
  },
};
