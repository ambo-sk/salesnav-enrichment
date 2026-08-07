/**
 * Client for the Cloudflare enrichment worker.
 *
 * The extension holds ONE credential: the user's bearer token. The HarvestAPI
 * and OpenRouter keys live in Worker secrets and are never exposed here — every
 * upstream call goes through /proxy/*.
 */

import type { RunConfig } from '../enrichment/runner';

export interface WorkerConfig {
  workerUrl: string;
  apiToken: string;
}

/** Distinguishes "the worker said no" from "the network died", because only
 *  one of those is worth retrying. */
export class WorkerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WorkerApiError';
  }
}

export function normalizeWorkerUrl(workerUrl: string): string {
  return workerUrl.trim().replace(/\/+$/, '');
}

async function call(config: WorkerConfig, path: string, init: RequestInit = {}): Promise<Response> {
  if (!config.workerUrl) throw new WorkerApiError('Worker URL not configured', 0, false);
  if (!config.apiToken) throw new WorkerApiError('API token not configured', 0, false);

  let response: Response;
  try {
    response = await fetch(`${normalizeWorkerUrl(config.workerUrl)}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (error) {
    throw new WorkerApiError(
      `network error: ${error instanceof Error ? error.message : String(error)}`,
      0,
      true,
    );
  }

  if (!response.ok) {
    const detail = await readError(response);
    const retryable = response.status >= 500 || response.status === 429;
    throw new WorkerApiError(detail, response.status, retryable);
  }

  return response;
}

async function readError(response: Response): Promise<string> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    /* unreadable */
  }

  if (response.status === 401) {
    return 'Authentication failed — check the API token in Settings';
  }

  try {
    const parsed = JSON.parse(body) as { error?: string; detail?: string };
    if (parsed.error) return parsed.detail ? `${parsed.error}: ${parsed.detail}` : parsed.error;
  } catch {
    /* not JSON */
  }
  return body ? `HTTP ${response.status}: ${body.slice(0, 200)}` : `HTTP ${response.status}`;
}

/** Pipeline knobs + the ICP. Fetched at run start so the worker stays the
 *  single place they are edited. */
export async function fetchConfig(config: WorkerConfig): Promise<RunConfig> {
  const response = await call(config, '/config');
  return (await response.json()) as RunConfig;
}

/** Open the usage record. Best-effort: a run must not be blocked by logging. */
export async function startRun(
  config: WorkerConfig,
  payload: { label: string; contactCount: number; icp?: string },
): Promise<string | null> {
  try {
    const response = await call(config, '/runs', {
      method: 'POST',
      body: JSON.stringify({
        label: payload.label,
        contact_count: payload.contactCount,
        ...(payload.icp ? { icp: payload.icp } : {}),
      }),
    });
    const data = (await response.json()) as { run_id?: string };
    return data.run_id ?? null;
  } catch (err) {
    console.warn('[worker-api] could not open run record:', err);
    return null;
  }
}

/** Close the usage record. Best-effort for the same reason. */
export async function finishRun(
  config: WorkerConfig,
  runId: string,
  totals: {
    status: string;
    scoredCount: number;
    harvestCalls: number;
    llmCalls: number;
    llmTokensIn: number;
    llmTokensOut: number;
    error?: string | null;
  },
): Promise<void> {
  try {
    await call(config, `/runs/${encodeURIComponent(runId)}/finish`, {
      method: 'POST',
      body: JSON.stringify({
        status: totals.status,
        scored_count: totals.scoredCount,
        harvest_calls: totals.harvestCalls,
        llm_calls: totals.llmCalls,
        llm_tokens_in: totals.llmTokensIn,
        llm_tokens_out: totals.llmTokensOut,
        error: totals.error ?? null,
      }),
    });
  } catch (err) {
    console.warn('[worker-api] could not close run record:', err);
  }
}

// ─── Lix company resolution (company list -> Sales Nav URL) ───

export interface LixResolveResult {
  resolved: { query: string; id: string; text: string }[];
  unresolved: string[];
}

/** Worker caps a /proxy/lix call at 20 names (free-plan subrequest budget). */
const LIX_BATCH_SIZE = 20;

/** Legal suffixes and decorations that make Lix miss an otherwise-findable
 *  company page. Only applied on a retry after the raw name failed. */
const LEGAL_SUFFIX =
  /[\s,.]+(ltd|limited|inc|incorporated|llc|llp|plc|pllc|gmbh|ag|sa|sarl|sas|srl|spa|bv|nv|ab|aps|oyj?|pty|pte|co|corp|corporation|company|holdings?|group)\.?$/i;

export function cleanCompanyName(name: string): string {
  let out = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(LEGAL_SUFFIX, '').trim();
  }
  return out;
}

async function resolveBatches(config: WorkerConfig, names: string[]): Promise<LixResolveResult> {
  const resolved: LixResolveResult['resolved'] = [];
  const unresolved: string[] = [];

  for (let i = 0; i < names.length; i += LIX_BATCH_SIZE) {
    const batch = names.slice(i, i + LIX_BATCH_SIZE);
    const response = await call(config, '/proxy/lix', {
      method: 'POST',
      body: JSON.stringify({ names: batch }),
    });
    const data = (await response.json()) as Partial<LixResolveResult>;
    resolved.push(...(data.resolved ?? []));
    unresolved.push(...(data.unresolved ?? []));
  }

  return { resolved, unresolved };
}

/**
 * Resolve company names to LinkedIn facet ids via the worker's Lix proxy.
 * Sequential batches — each worker invocation has its own subrequest budget.
 * Names that fail as scraped are retried once with legal suffixes stripped
 * ("Acme Payments Ltd." -> "Acme Payments").
 */
export async function resolveCompanies(
  config: WorkerConfig,
  names: string[],
): Promise<LixResolveResult> {
  const first = await resolveBatches(config, names);

  // cleaned -> original, so recovered names are reported under what was scraped
  const retry = new Map<string, string>();
  for (const original of first.unresolved) {
    const cleaned = cleanCompanyName(original);
    if (cleaned && cleaned !== original && !retry.has(cleaned)) retry.set(cleaned, original);
  }

  let resolved = first.resolved;
  let unresolved = first.unresolved;
  if (retry.size > 0) {
    const second = await resolveBatches(config, [...retry.keys()]);
    const recovered = new Set(
      second.resolved.map((r) => retry.get(r.query)).filter((n): n is string => !!n),
    );
    resolved = [...resolved, ...second.resolved];
    unresolved = unresolved.filter((n) => !recovered.has(n));
  }

  // Same company can appear on many scraped pages under slightly different
  // names — Lix resolves them to one id; dedupe across batches.
  const seen = new Set<string>();
  return {
    resolved: resolved.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))),
    unresolved,
  };
}

export interface RunSummary {
  id: string;
  label: string | null;
  status: string;
  contact_count: number;
  scored_count: number;
  harvest_calls: number;
  llm_calls: number;
  created_at: string;
  finished_at: string | null;
}

export async function listRuns(config: WorkerConfig): Promise<RunSummary[]> {
  const response = await call(config, '/runs');
  const data = (await response.json()) as { runs?: RunSummary[] };
  return data.runs ?? [];
}
