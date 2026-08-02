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
