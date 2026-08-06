/**
 * HarvestAPI client — routed through the Cloudflare worker's proxy.
 *
 * The extension never sees the HarvestAPI key. It POSTs {path, params} to
 * `/proxy/harvest` with its own bearer token; the worker attaches the real key
 * and forwards. Each proxy call is a separate Worker invocation with exactly
 * one subrequest, which is what keeps the whole pipeline inside the free plan's
 * 50-subrequests-per-invocation and 10ms-CPU ceilings.
 *
 * Concurrency is capped per HarvestAPI ACCOUNT (free 1 / starter 5 / basic 10 /
 * pro 20 / business 40) with a max queue of ~10. There is no per-minute rate
 * limit. Overflow surfaces as an error body rather than a 429, so `isRetryable`
 * matches on the message text as well as the status code.
 */

import type { HarvestCompany, HarvestEnvelope, HarvestProfile } from './harvest-types';

export class HarvestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HarvestError';
  }
}

/** Retryable: transport blips, 5xx, 429, and HarvestAPI's queue-overflow reply. */
function isRetryable(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status === 408) return true;
  return /queue|concurren|too many|timeout|temporarily/i.test(body);
}

export interface HarvestConfig {
  /** Base URL of the enrichment worker, no trailing slash. */
  workerUrl: string;
  /** The user's bearer token — NOT the HarvestAPI key. */
  apiToken: string;
  /** Total attempts per request (1 initial + N-1 retries). */
  attempts?: number;
}

export class HarvestClient {
  private readonly config: HarvestConfig;
  private readonly attempts: number;
  /** Number of proxied calls made — feeds the run's usage report. */
  calls = 0;

  constructor(config: HarvestConfig) {
    this.config = config;
    this.attempts = config.attempts ?? 4;
  }

  private async request<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') clean[key] = value;
    }

    let lastError: HarvestError | null = null;

    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) {
        // 1.5s, 4.5s, 13.5s (+/- 30% jitter) — long enough for a full
        // HarvestAPI queue to drain, short enough to keep a batch moving.
        const base = 1500 * Math.pow(3, attempt - 1);
        const jitter = base * 0.3 * (Math.random() * 2 - 1);
        await sleep(base + jitter);
      }

      this.calls++;
      let response: Response;
      try {
        response = await fetch(`${this.config.workerUrl}/proxy/harvest`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ path, params: clean }),
        });
      } catch (err) {
        lastError = new HarvestError(
          `network error: ${err instanceof Error ? err.message : String(err)}`,
          0,
          true,
        );
        continue;
      }

      const text = await response.text();

      if (!response.ok) {
        const message = extractMessage(text) || `HTTP ${response.status}`;
        // 401/403 from the PROXY mean the extension's own token is bad — never
        // retryable, and distinct from HarvestAPI rejecting the lookup.
        const retryable =
          response.status !== 401 && response.status !== 403 && isRetryable(response.status, text);
        lastError = new HarvestError(message, response.status, retryable);
        if (!retryable) throw lastError;
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        lastError = new HarvestError('invalid JSON from proxy', response.status, true);
        continue;
      }

      // HarvestAPI returns application-level errors inside a 200 envelope
      // (a missing profile is {element: null, status: 404, error: "..."}).
      const envelope = parsed as HarvestEnvelope<unknown>;
      if (envelope && typeof envelope === 'object' && envelope.error) {
        const retryable = isRetryable(response.status, envelope.error);
        lastError = new HarvestError(envelope.error, response.status, retryable);
        if (!retryable) throw lastError;
        continue;
      }

      return parsed as T;
    }

    throw lastError ?? new HarvestError('request failed', 0, false);
  }

  /**
   * One profile. Sales Navigator URLs carry the member id in the path and are
   * NOT resolvable as `url` — they must be passed as `profileId`.
   */
  async getProfile(
    key: { type: 'profileId' | 'url'; value: string },
    opts: { findEmail?: boolean } = {},
  ): Promise<HarvestProfile | null> {
    const params: Record<string, string | undefined> = {
      [key.type === 'profileId' ? 'profileId' : 'url']: key.value,
    };
    if (opts.findEmail) params.findEmail = 'true';

    const result = await this.request<HarvestEnvelope<HarvestProfile>>('/linkedin/profile', params);
    return result.element ?? null;
  }

  async getCompany(universalName: string): Promise<HarvestCompany | null> {
    const result = await this.request<HarvestEnvelope<HarvestCompany>>('/linkedin/company', {
      universalName,
    });
    return result.element ?? null;
  }

  /**
   * Company lookup by display name. Fuzzier than `universalName` — used only
   * when the profile did not expose a company slug, and deduped by the caller
   * so the fuzzy path costs at most one credit per distinct name.
   */
  async searchCompany(name: string): Promise<HarvestCompany | null> {
    const result = await this.request<HarvestEnvelope<HarvestCompany>>('/linkedin/company', {
      search: name,
    });
    return result.element ?? null;
  }

}

/** Pull a human-readable message out of an error body. */
function extractMessage(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string | number };
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    /* not JSON — fall through */
  }
  return text ? text.slice(0, 300) : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `tasks` with at most `limit` in flight, preserving input order in the
 * result. Rejections are NOT caught here — each task is expected to be
 * self-wrapping (the enrich path records per-contact errors itself).
 */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  });

  await Promise.all(workers);
  return results;
}
