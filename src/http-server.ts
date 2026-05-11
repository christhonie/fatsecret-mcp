#!/usr/bin/env node
/**
 * Streamable HTTP transport for the FatSecret MCP server.
 * Designed for remote deployment behind TLS (e.g. K8s ingress + cert-manager).
 *
 * Auth model: single-user. FatSecret credentials and the pre-authenticated
 * OAuth 1.0a user token come from env vars (see .env.example). The /mcp
 * endpoint itself is gated by a shared bearer token (MCP_BEARER_TOKEN).
 *
 * Bootstrap the OAuth token once locally via `npm run bootstrap`, then bake
 * the printed values into the Kubernetes Secret referenced by the Deployment.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { FatSecretMcpServer } from './index.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[fatsecret-mcp] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const BEARER_TOKEN = requireEnv('MCP_BEARER_TOKEN');
// Fail fast on the FatSecret side too so we don't return cryptic per-request errors.
requireEnv('FATSECRET_CLIENT_ID');
requireEnv('FATSECRET_CLIENT_SECRET');
requireEnv('FATSECRET_CONSUMER_SECRET');
requireEnv('FATSECRET_ACCESS_TOKEN');
requireEnv('FATSECRET_ACCESS_TOKEN_SECRET');

const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? '0.0.0.0';
const ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const requireBearer = (req: Request, res: Response, next: NextFunction) => {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token !== BEARER_TOKEN) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
    return;
  }
  if (ALLOWED_ORIGINS.length > 0) {
    const origin = req.header('origin');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32002, message: 'Forbidden origin' },
        id: null,
      });
      return;
    }
  }
  next();
};

// One transport (and one FatSecretMcpServer) per MCP session. Sessions persist
// for the lifetime of a chat conversation on the client side.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post('/mcp', requireBearer, async (req, res) => {
  const sid = req.header('mcp-session-id');
  let transport = sid ? transports.get(sid) : undefined;

  if (!transport) {
    if (sid) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32004, message: 'Unknown session' },
        id: null,
      });
      return;
    }
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32003, message: 'First request must be initialize' },
        id: null,
      });
      return;
    }

    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, newTransport);
        console.error(`[fatsecret-mcp] session opened: ${id}`);
      },
    });
    newTransport.onclose = () => {
      if (newTransport.sessionId) {
        transports.delete(newTransport.sessionId);
        console.error(`[fatsecret-mcp] session closed: ${newTransport.sessionId}`);
      }
    };

    const mcp = new FatSecretMcpServer({ allowAuthTools: false });
    await mcp.server.connect(newTransport);
    transport = newTransport;
  }

  await transport.handleRequest(req, res, req.body);
});

const handleSessionGetDelete = async (req: Request, res: Response) => {
  const sid = req.header('mcp-session-id');
  const transport = sid ? transports.get(sid) : undefined;
  if (!transport) {
    res.status(400).send('Missing or unknown Mcp-Session-Id');
    return;
  }
  await transport.handleRequest(req, res);
};

app.get('/mcp', requireBearer, handleSessionGetDelete);
app.delete('/mcp', requireBearer, handleSessionGetDelete);

const server = app.listen(PORT, HOST, () => {
  console.error(`[fatsecret-mcp] Streamable HTTP listening on http://${HOST}:${PORT}`);
  console.error(`[fatsecret-mcp] MCP endpoint: POST /mcp (Authorization: Bearer <MCP_BEARER_TOKEN>)`);
});

const shutdown = (signal: string) => {
  console.error(`[fatsecret-mcp] ${signal} received, draining…`);
  server.close(() => process.exit(0));
  for (const t of transports.values()) t.close();
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => console.error('[fatsecret-mcp] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[fatsecret-mcp] unhandledRejection:', err));
