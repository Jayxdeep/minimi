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
  DEEPSEEK_BASE_URL: z.string().trim().url().default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().trim().min(1).default('deepseek-chat'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),

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
  deepseekBaseUrl: string;
  deepseekModel: string;
  llmTimeoutMs: number;
  tavilyApiKey: string | undefined;
}

export const config: Config = {
  port: parsed.data.PORT,
  dbPath: parsed.data.DB_PATH,
  streamTokenDelayMs: parsed.data.STREAM_TOKEN_DELAY_MS,
  deepseekApiKey: parsed.data.DEEPSEEK_API_KEY,
  deepseekBaseUrl: parsed.data.DEEPSEEK_BASE_URL,
  deepseekModel: parsed.data.DEEPSEEK_MODEL,
  llmTimeoutMs: parsed.data.LLM_TIMEOUT_MS,
  tavilyApiKey: parsed.data.TAVILY_API_KEY,
};
