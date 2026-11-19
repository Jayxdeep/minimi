import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Persistence-shape types                                                     */
/* -------------------------------------------------------------------------- */

export type Role = 'user' | 'assistant' | 'system';

export interface Session {
  id: string;
  startedAt: string;
  userTz: string;
}

/** An episode. Every turn is stored verbatim and never rewritten. */
export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
}

/**
 * A claim is structured, not prose, because change detection is a diff.
 * `attribute` is the dimension that can change (pricing, plan_tier, release...).
 * `as_of` is the earliest time we can honestly say the claim was true
 * (usually a source's publish date) and may be null when unknowable.
 */
export const ClaimSchema = z.object({
  subject: z.string().min(1),
  attribute: z.string().min(1),
  value: z.string(),
  as_of: z.string().nullable(),
  source_ids: z.array(z.number().int().nonnegative()),
  confidence: z.number().min(0).max(1),
});

export type Claim = z.infer<typeof ClaimSchema>;
export type ClaimInput = z.input<typeof ClaimSchema>;

/**
 * A source is stored with the snippet we actually read and a content hash,
 * so a future turn can tell "the page changed" without trusting a publish date.
 */
export const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  published_date: z.string().nullable().default(null),
  retrieved_at: z.string().default(() => new Date().toISOString()),
  snippet: z.string().default(''),
  content_hash: z.string().nullable().default(null),
});

export type Source = z.infer<typeof SourceSchema>;
export type SourceInput = z.input<typeof SourceSchema>;

/** One per assistant answer that carries at least one verifiable claim. */
export interface Snapshot {
  id: string;
  messageId: string;
  label: string;
  /** Stable key used to chain "what we said then" to "what is true now". */
  topicKey: string;
  entities: string[];
  claims: Claim[];
  sources: Source[];
  /** When we observed the sources. We never claim this is when the world changed. */
  observedAt: string;
  supersedesId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Planner contract (implemented in Phase 1, defined now so it is reviewable)  */
/* -------------------------------------------------------------------------- */

export const PlannerOutputSchema = z.object({
  intent: z.enum(['recall', 'lookup', 'change', 'chat']),
  now_iso: z.string(),
  temporal_refs: z.array(
    z.object({
      expression: z.string(),
      resolved_range: z.tuple([z.string(), z.string()]),
    }),
  ),
  memory: z.object({
    window: z.tuple([z.string(), z.string()]).nullable(),
    keywords: z.array(z.string()),
  }),
  search_plan: z.array(
    z.object({
      query: z.string().min(1),
      mode: z.enum(['quick', 'deep', 'news']),
      since: z.string().optional(),
    }),
  ),
  verify_snapshot_ids: z.array(z.string()),
});

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/* -------------------------------------------------------------------------- */
/* HTTP / SSE contract                                                         */
/* -------------------------------------------------------------------------- */

export const ChatRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  message: z.string().trim().min(1).max(8_000),
  userTz: z.string().min(1).max(64).optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * Every SSE frame is `data: <json>\n\n`. `status` and `plan` are progress
 * signals; only `token` carries answer text.
 */
export type SseEvent =
  | { type: 'status'; text: string }
  | { type: 'plan'; plan: PlannerOutput }
  | { type: 'token'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };
