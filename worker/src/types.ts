/**
 * Types for the enrichment proxy worker.
 *
 * The worker holds the credentials and the scoring prompt. It does NOT hold
 * contact data: enrichment and workbook building happen in the extension, so
 * nothing here needs the HarvestAPI response shapes beyond passing them back.
 */

export interface Env {
  DB: D1Database;

  // Secrets — never leave the worker
  HARVEST_API_KEY: string;
  OPENROUTER_API_KEY: string;
  /** Optional. Absent = the contacts phase is reported off in GET /config. */
  SIMILARWEB_API_KEY: string;
  /** Optional. Absent = POST /proxy/lix returns 501 (company URL builder off). */
  LIX_API_KEY: string;

  // Vars
  OPENROUTER_MODEL: string;
  HARVEST_CONCURRENCY: string;
  FIND_EMAIL: string;
  COMPANY_NAME_FALLBACK: string;
  DEFAULT_ICP: string;
  MAX_CONTACTS_PER_JOB: string;
  ALLOWED_ORIGINS: string;
  /** Per-user daily ceilings. A leaked token cannot drain the API balance. */
  DAILY_HARVEST_CALL_LIMIT: string;
  DAILY_LLM_CALL_LIMIT: string;
}

export interface AuthedUser {
  id: string;
  name: string;
}

/** Runtime knobs the extension fetches from GET /config. */
export interface ClientConfig {
  icp: string;
  model: string;
  harvestConcurrency: number;
  findEmail: boolean;
  companyNameFallback: boolean;
  maxContactsPerRun: number;
  /** Similarweb contact enrichment is configured — run the contacts phase. */
  findContacts: boolean;
}

/** A run, as reported by the extension when it starts and finishes. */
export interface RunRow {
  id: string;
  user_id: string;
  label: string | null;
  status: string;
  contact_count: number;
  scored_count: number;
  harvest_calls: number;
  llm_calls: number;
  llm_tokens_in: number;
  llm_tokens_out: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

// ─── Scoring ───

export interface Score {
  fit_score: number;
  tier: 'A' | 'B' | 'C' | 'D';
  verdict: 'strong_fit' | 'fit' | 'weak_fit' | 'not_fit';
  seniority: string;
  buying_role: string;
  rationale: string;
  positive_signals: string[];
  risks: string[];
  personalized_hook: string;
  recommended_channel: string;
  confidence: 'high' | 'medium' | 'low';
}
