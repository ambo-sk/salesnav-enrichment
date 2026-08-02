/**
 * Scoring client — POSTs a dossier to the worker and gets a Score back.
 *
 * The prompt, the ICP and the model live on the worker. This side sends only
 * the dossier, so the endpoint cannot be driven as a general LLM gateway even
 * by someone holding a valid bearer token.
 */

import type { Score } from './harvest-types';

export interface ScoreUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ScoreResult {
  score: Score | null;
  error: string | null;
  usage: ScoreUsage;
}

const EMPTY_USAGE: ScoreUsage = { calls: 0, tokensIn: 0, tokensOut: 0 };

/**
 * Never throws. A failure returns `score: null` with the reason so one bad
 * contact cannot abort a 1000-contact run — the workbook records it in the
 * row's Data Gaps column.
 */
export async function scoreDossier(
  dossier: string,
  config: { workerUrl: string; apiToken: string; icp?: string },
): Promise<ScoreResult> {
  // The worker retries internally (structured output, then a plain-JSON
  // fallback). This layer only retries the transport.
  let lastError = 'unknown error';

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));

    let response: Response;
    let text: string;
    try {
      response = await fetch(`${config.workerUrl}/proxy/score`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dossier, ...(config.icp ? { icp: config.icp } : {}) }),
      });
      // Inside the try: fetch resolves on headers, so a connection cut
      // mid-stream rejects on the body read, not above.
      text = await response.text();
    } catch (err) {
      lastError = `network error: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    if (!response.ok) {
      lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
      // A dead token or an exhausted daily quota fails identically for every
      // contact — surface it immediately instead of burning the retries.
      if ([400, 401, 403, 413, 429].includes(response.status)) break;
      continue;
    }

    try {
      const parsed = JSON.parse(text) as ScoreResult;
      return {
        score: parsed.score ?? null,
        error: parsed.error ?? null,
        usage: parsed.usage ?? EMPTY_USAGE,
      };
    } catch {
      lastError = `invalid JSON from proxy: ${text.slice(0, 150)}`;
    }
  }

  return { score: null, error: lastError, usage: EMPTY_USAGE };
}

/** True when the failure will repeat for every remaining contact. */
export function isFatalScoringError(error: string | null): boolean {
  if (!error) return false;
  return /HTTP (401|403|429)|daily .* limit|unauthorized/i.test(error);
}
