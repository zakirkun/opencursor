/** opencursor desktop server — HTTP + SSE bridge between the GUI and the agent runtime. */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import process from 'node:process';
import {
  createAgentRuntime,
  createBuiltinRegistry,
  createSqliteSessionStore,
  createCheckpointStore,
  createArchiveStore,
  createShellRegistry,
  createPermissionPolicy,
  createSubagentRunner,
  createModelClient,
  createMemoryStore,
  createMcpManager,
  createHookRunner,
  createDefaultIndexer,
  detectModelConfig,
  openDatabase,
  closeDatabase,
  resolveHomebase,
  ensureHomebase,
  loadConfig,
  SUBAGENT_PROFILES,
} from '@opencursor/core';
import type { AgentRuntime, PermissionDecision } from '@opencursor/core';
import type { ServerContext, RpcRequest } from './types.js';
import { handleRpc } from './rpc.js';

const DEFAULT_PORT = 4180;

function parseArgs(argv: string[]): { port: number; cwd: string } {
  let port = DEFAULT_PORT;
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(value) && value >= 0 && value <= 65535) port = value;
    } else if (arg === '--cwd') {
      const value = argv[++i];
      if (value) cwd = value;
    }
  }
  return { port, cwd };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

async function main(): Promise<void> {
  const { port, cwd } = parseArgs(process.argv.slice(2));

  const home = resolveHomebase();
  ensureHomebase(home);
  const { config } = loadConfig(home);
  const db = openDatabase(home.db_path);
  const modelConfig = detectModelConfig(undefined, { provider: config.provider, model: config.model });
  const modelClient = createModelClient(modelConfig);
  const store = createSqliteSessionStore(db);
  const memory = createMemoryStore(db, home);
  const mcp = createMcpManager(config.mcp_servers);
  const hooks = createHookRunner(config.hooks);
  const shells = createShellRegistry();
  const checkpoints = createCheckpointStore(db);
  const archives = createArchiveStore(db);
  const indexer = createDefaultIndexer({ cwd, db });
  const tools = createBuiltinRegistry({ mcp });
  const permissions = createPermissionPolicy({
    mode: config.permission_mode,
    persist_path: `${home.root}/permissions.json`,
  });
  const subagents = createSubagentRunner({ model_client: modelClient, tools });

  let runtime: AgentRuntime | null = null;
  let runtimeEventsPump: Promise<void> | null = null;

  const sseClients = new Set<ServerResponse>();
  const pendingPermissions = new Map<
    string,
    { resolve: (decision: PermissionDecision) => void; tool: string; summary: string; args: unknown }
  >();
  const pendingQuestions = new Map<
    string,
    { resolve: (answers: Array<{ question: string; answers: string[] }>) => void }
  >();

  const broadcast = (message: unknown): void => {
    const payload = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const createRuntime = async (sessionId?: string): Promise<AgentRuntime> => {
    const created = await createAgentRuntime({
      cwd,
      model_client: modelClient,
      tools,
      store,
      permissions,
      askPermission: (view) =>
        new Promise<PermissionDecision>((resolve) => {
          const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          pendingPermissions.set(requestId, { resolve, tool: view.tool, summary: view.summary, args: view.args });
          broadcast({
            type: 'permission-request',
            request_id: requestId,
            tool: view.tool,
            summary: view.summary,
            args: view.args,
          });
        }),
      askUser: (questions) =>
        new Promise((resolve) => {
          const requestId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          pendingQuestions.set(requestId, { resolve });
          broadcast({ type: 'question-request', request_id: requestId, questions });
        }),
      subagents,
      subagent_profiles: SUBAGENT_PROFILES,
      session_id: sessionId,
      memory,
      memory_options: {
        auto_summarize: config.memory.auto_summarize,
        capture_artifacts: config.memory.capture_artifacts,
        max_digest_chars: config.memory.max_digest_chars,
      },
      max_iterations: config.max_iterations,
      hooks: hooks ?? undefined,
      shells,
      checkpoints,
      archives,
      indexer,
      context_options: {
        enabled: config.context.enabled,
        max_chars: config.context.max_chars,
        keep_recent: config.context.keep_recent,
      },
    });
    runtime = created;
    return created;
  };

  const pumpEvents = (target: AgentRuntime): void => {
    runtimeEventsPump = (async () => {
      for await (const event of target.events()) {
        broadcast({ type: 'agent-event', event });
      }
    })();
    void runtimeEventsPump.catch(() => undefined);
  };

  const ctx: ServerContext = {
    cwd,
    home,
    config,
    db,
    store,
    memory,
    mcp,
    indexer,
    tools,
    modelClient,
    getRuntime: () => runtime,
    createRuntime,
    pumpEvents,
    broadcast,
    pendingPermissions,
    pendingQuestions,
    sseClientCount: () => sseClients.size,
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'OPTIONS') {
        writeJson(res, 204, {});
        return;
      }
      if (url.pathname === '/api/health') {
        writeJson(res, 200, { ok: true, cwd, session: runtime ? runtime.session_id : null });
        return;
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        res.write(`data: ${JSON.stringify({ type: 'hello', cwd })}\n\n`);
        sseClients.add(res);
        const keepAlive = setInterval(() => {
          try {
            res.write(': keep-alive\n\n');
          } catch {
            clearInterval(keepAlive);
          }
        }, 15_000);
        req.on('close', () => {
          clearInterval(keepAlive);
          sseClients.delete(res);
        });
        return;
      }
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        let request: RpcRequest;
        try {
          const body = await readBody(req);
          request = JSON.parse(body) as RpcRequest;
        } catch (error) {
          writeJson(res, 400, { id: null, error: `invalid request: ${String(error)}` });
          return;
        }
        try {
          const result = await handleRpc(ctx, request);
          writeJson(res, 200, { id: request.id, result });
        } catch (error) {
          writeJson(res, 200, {
            id: request.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      writeJson(res, 404, { error: 'not found' });
    })().catch((error) => {
      try {
        writeJson(res, 500, { error: String(error) });
      } catch {
        // response already sent
      }
    });
  });

  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : port;
    process.stdout.write(`OPENCURSOR_SERVER_PORT=${boundPort}\n`);
    process.stdout.write(`opencursor server listening on http://127.0.0.1:${boundPort} (cwd: ${cwd})\n`);
  });

  const shutdown = async (): Promise<void> => {
    shells.killAll();
    await mcp.closeAll().catch(() => undefined);
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // already closed
      }
    }
    closeDatabase(db);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('uncaughtException', (error) => {
    process.stderr.write(`uncaught: ${String(error)}\n`);
  });
}

main().catch((error) => {
  process.stderr.write(`opencursor server failed: ${String(error)}\n`);
  process.exit(1);
});
