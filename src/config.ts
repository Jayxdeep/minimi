import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const optionalKey = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DB_PATH: z.string().trim().min(1).default('./data/agent.db'),
  STREAM_TOKEN_DELAY_MS: z.coerce.number().int().min(0).default(30),
  DEEPSEEK_API_KEY: optionalKey,
  TAVILY_API_KEY: optionalKey,
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid environment: ${detail}`);
}

export interface Config {
  port: number;
  dbPath: string;
  streamTokenDelayMs: number;
  deepseekApiKey: string | undefined;
  tavilyApiKey: string | undefined;
}

export const config: Config = {
  port: parsed.data.PORT,
  dbPath: parsed.data.DB_PATH,
  streamTokenDelayMs: parsed.data.STREAM_TOKEN_DELAY_MS,
  deepseekApiKey: parsed.data.DEEPSEEK_API_KEY,
  tavilyApiKey: parsed.data.TAVILY_API_KEY,
};
