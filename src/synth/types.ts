import { z } from 'zod';
import type { Claim, Source } from '../types';

/**
 * The synthesizer's structured tail. The model never emits URLs: it emits 1-based
 * indexes into the numbered SOURCES block it was given, and code maps them back
 * to real search results. That is a citation check by construction.
 */

export const ClaimDraftSchema = z.object({
  subject: z.string().min(1),
  attribute: z.string().min(1),
  value: z.string(),
  as_of: z.string().nullable(),
  source_ids: z.array(z.number().int().positive()),
  confidence: z.number().min(0).max(1),
});

export type ClaimDraft = z.infer<typeof ClaimDraftSchema>;

export const SynthesisTrailerSchema = z.object({
  label: z.string().min(1).max(200),
  entities: z.array(z.string()).max(20).default([]),
  claims: z.array(ClaimDraftSchema).max(30).default([]),
  used_sources: z.array(z.number().int().positive()).max(50).default([]),
  supersedes_id: z.string().nullable().default(null),
});

export type SynthesisTrailer = z.infer<typeof SynthesisTrailerSchema>;

export interface SynthesisSnapshot {
  label: string;
  entities: string[];
  claims: Claim[];
  sources: Source[];
  supersedesId: string | null;
}

export interface SynthesisResult {
  answer: string;
  /** Null when the answer made no citable claims (chat, or an honest gap). */
  snapshot: SynthesisSnapshot | null;
}
