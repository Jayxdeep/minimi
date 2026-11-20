import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express, { type Express } from 'express';
import { config } from './config';
import { createDb, type Db } from './db';
import { DeepSeekClient } from './llm/deepseek';
import { createPlanner, type Planner } from './planner';
import { createChatRouter } from './routes/chat';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export interface AppOptions {
  chunkDelayMs?: number;
  /**
   * Explicit by design: tests must never inherit a real planner just because
   * the developer happens to have a key in `.env`.
   */
  planner?: Planner | null;
  now?: () => Date;
}

export function createApp(db: Db, options: AppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.get('/health', (_req, res) => {
    const up = db.ping();
    res.status(up ? 200 : 503).json({ ok: up, db: up ? 'up' : 'down' });
  });

  app.use(
    createChatRouter({
      db,
      chunkDelayMs: options.chunkDelayMs ?? config.streamTokenDelayMs,
      planner: options.planner ?? null,
      ...(options.now ? { now: options.now } : {}),
    }),
  );

  return app;
}

export function buildPlanner(): Planner | null {
  if (!config.deepseekApiKey) return null;

  return createPlanner(
    new DeepSeekClient({
      apiKey: config.deepseekApiKey,
      baseUrl: config.deepseekBaseUrl,
      model: config.deepseekModel,
      timeoutMs: config.llmTimeoutMs,
    }),
  );
}

export function startServer(): void {
  const db = createDb(config.dbPath);
  db.migrate();

  const planner = buildPlanner();
  const app = createApp(db, { planner });

  const server = app.listen(config.port, () => {
    const mode = planner
      ? `planner (${config.deepseekModel})`
      : 'echo (no DEEPSEEK_API_KEY)';
    console.log(`minimi-agent  http://localhost:${config.port}`);
    console.log(`db: ${path.resolve(config.dbPath)}`);
    console.log(`mode: ${mode}`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1];
const isMainModule =
  entry !== undefined && pathToFileURL(entry).href === import.meta.url;

if (isMainModule) {
  startServer();
}
